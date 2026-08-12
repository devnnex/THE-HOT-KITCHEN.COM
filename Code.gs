const SPREADSHEET_ID = "";
const ADMIN_PASSWORD = "5678";
const ADMIN_TOKEN = ADMIN_PASSWORD;
const MENU_CACHE_KEY = "thk_menu_v1";
const MENU_CACHE_TTL_SECONDS = 15;
const CACHE_MAX_BYTES = 95000;

const CONFIG = {
  productos: {
    sheetName: "productos",
    idKey: "producto_id",
    headers: ["producto_id", "categoria_id", "nombre", "precio", "descripcion", "imagen", "opciones", "orden", "activo"]
  },
  extras: {
    sheetName: "extras",
    idKey: "extra_id",
    headers: ["extra_id", "nombre", "precio", "orden", "activo"]
  }
};

function doGet(e) {
  try {
    var action = param_(e, "action", "menu");

    if (action === "menu" || action === "read") {
      return json_({ ok: true, data: getMenuData_() });
    }

    if (action === "ping") {
      return json_({ ok: true, data: { status: "online", updatedAt: new Date().toISOString() } });
    }

    return json_({ ok: false, error: "Accion GET no soportada: " + action });
  } catch (error) {
    return json_({ ok: false, error: errorMessage_(error) });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();

  try {
    lock.waitLock(15000);

    var body = parseBody_(e);
    validateAdminPassword_(body.password || body.token);

    if (body.action === "upsertProduct" || body.action === "addProduct" || body.action === "editProduct") {
      var product = normalizeProduct_(body.product || body.producto || body);
      upsert_(CONFIG.productos, product);
      invalidateMenuCache_();
      return json_({ ok: true, data: { product: product } });
    }

    if (body.action === "upsertExtra" || body.action === "addExtra" || body.action === "editExtra") {
      var extra = normalizeExtra_(body.extra || body);
      upsert_(CONFIG.extras, extra);
      invalidateMenuCache_();
      return json_({ ok: true, data: { extra: extra } });
    }

    if (body.action === "deleteProduct") {
      var productId = required_(body.producto_id || body.product_id, "producto_id");
      deleteOrDeactivate_(CONFIG.productos, productId, true);
      invalidateMenuCache_();
      return json_({ ok: true, data: { producto_id: productId } });
    }

    if (body.action === "deleteExtra") {
      var extraId = required_(body.extra_id, "extra_id");
      deleteOrDeactivate_(CONFIG.extras, extraId, body.hardDelete === true);
      invalidateMenuCache_();
      return json_({ ok: true, data: { extra_id: extraId } });
    }

    if (body.action === "setup") {
      ensureSheet_(CONFIG.productos);
      ensureSheet_(CONFIG.extras);
      invalidateMenuCache_();
      return json_({ ok: true, data: { message: "Hojas listas" } });
    }

    return json_({ ok: false, error: "Accion POST no soportada: " + body.action });
  } catch (error) {
    return json_({ ok: false, error: errorMessage_(error) });
  } finally {
    try {
      lock.releaseLock();
    } catch (ignored) {}
  }
}

function getMenuData_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get(MENU_CACHE_KEY);

  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (ignored) {
      cache.remove(MENU_CACHE_KEY);
    }
  }

  var data = {
    products: readTable_(CONFIG.productos).map(normalizeProduct_).sort(sortByOrder_),
    extras: readTable_(CONFIG.extras).map(normalizeExtra_).sort(sortByOrder_),
    updatedAt: new Date().toISOString()
  };

  try {
    var serialized = JSON.stringify(data);
    if (serialized.length <= CACHE_MAX_BYTES) {
      cache.put(MENU_CACHE_KEY, serialized, MENU_CACHE_TTL_SECONDS);
    }
  } catch (ignored) {}

  return data;
}

function invalidateMenuCache_() {
  try {
    CacheService.getScriptCache().remove(MENU_CACHE_KEY);
  } catch (ignored) {}
}

function readTable_(tableConfig) {
  var sheet = ensureSheet_(tableConfig);
  var headers = getHeaders_(sheet, tableConfig.headers);
  var lastRow = sheet.getLastRow();

  if (lastRow < 2) return [];

  var rows = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var output = [];

  rows.forEach(function(row) {
    var hasValue = row.some(function(cell) { return String(cell).trim() !== ""; });
    if (!hasValue) return;

    var item = {};
    headers.forEach(function(header, index) { item[header] = row[index]; });
    output.push(item);
  });

  return output;
}

function upsert_(tableConfig, item) {
  var sheet = ensureSheet_(tableConfig);
  var headers = getHeaders_(sheet, tableConfig.headers);
  var rowIndex = findRow_(sheet, headers, tableConfig.idKey, item[tableConfig.idKey]);
  var values = headers.map(function(header) {
    return Object.prototype.hasOwnProperty.call(item, header) ? item[header] : "";
  });

  if (rowIndex > 0) {
    sheet.getRange(rowIndex, 1, 1, headers.length).setValues([values]);
  } else {
    sheet.appendRow(values);
  }
}

function deleteOrDeactivate_(tableConfig, id, hardDelete) {
  var sheet = ensureSheet_(tableConfig);
  var headers = getHeaders_(sheet, tableConfig.headers);
  var rowIndex = findRow_(sheet, headers, tableConfig.idKey, id);

  if (rowIndex < 1) throw new Error("No existe el registro: " + id);

  if (hardDelete) {
    sheet.deleteRow(rowIndex);
    return;
  }

  var activeColumn = headers.indexOf("activo") + 1;
  if (activeColumn < 1) throw new Error("Falta la columna activo");
  sheet.getRange(rowIndex, activeColumn).setValue(false);
}

function ensureSheet_(tableConfig) {
  var spreadsheet = spreadsheet_();
  var sheet = spreadsheet.getSheetByName(tableConfig.sheetName);

  if (!sheet) sheet = spreadsheet.insertSheet(tableConfig.sheetName);

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, tableConfig.headers.length).setValues([tableConfig.headers]);
    sheet.setFrozenRows(1);
    return sheet;
  }

  var headers = getHeaders_(sheet, tableConfig.headers);
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
  return sheet;
}

function getHeaders_(sheet, requiredHeaders) {
  var width = Math.max(sheet.getLastColumn(), requiredHeaders.length);
  var currentHeaders = sheet.getRange(1, 1, 1, width).getValues()[0]
    .map(function(header) { return String(header).trim(); })
    .filter(function(header) { return header !== ""; });

  requiredHeaders.forEach(function(header) {
    if (currentHeaders.indexOf(header) === -1) currentHeaders.push(header);
  });

  return currentHeaders;
}

function findRow_(sheet, headers, idKey, idValue) {
  var idColumn = headers.indexOf(idKey) + 1;
  if (idColumn < 1) throw new Error("Falta la columna " + idKey);

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;

  var values = sheet.getRange(2, idColumn, lastRow - 1, 1).getValues();
  var needle = String(idValue).trim();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim() === needle) return i + 2;
  }
  return -1;
}

function normalizeProduct_(product) {
  product = product || {};
  return {
    producto_id: clean_(product.producto_id || product.id || makeId_("prod")),
    categoria_id: slug_(product.categoria_id || product.category || "general"),
    nombre: required_(product.nombre || product.title, "nombre"),
    precio: number_(product.precio || product.price),
    descripcion: clean_(product.descripcion || product.desc),
    imagen: clean_(product.imagen || product.image),
    opciones: options_(product.opciones || product.options || product.sizes),
    orden: number_(product.orden),
    activo: bool_(product.activo)
  };
}

function options_(value) {
  if (!value) return "";
  if (Array.isArray(value)) {
    return JSON.stringify(value.map(function(option, index) {
      return {
        id: clean_(option.id || option.option_id || "opcion-" + (index + 1)),
        label: clean_(option.label || option.nombre || option.name || "Opcion " + (index + 1)),
        price: number_(option.price || option.precio),
        image: clean_(option.image || option.imagen)
      };
    }));
  }

  var text = clean_(value);
  if (!text) return "";
  try {
    var parsed = JSON.parse(text);
    return Array.isArray(parsed) ? options_(parsed) : "";
  } catch (ignored) {
    return text;
  }
}

function normalizeExtra_(extra) {
  extra = extra || {};
  return {
    extra_id: clean_(extra.extra_id || extra.id || makeId_("extra")),
    nombre: required_(extra.nombre || extra.name, "nombre"),
    precio: number_(extra.precio || extra.price),
    orden: number_(extra.orden),
    activo: bool_(extra.activo)
  };
}

function parseBody_(e) {
  if (!e || !e.postData || !e.postData.contents) return {};
  var raw = e.postData.contents;
  try {
    return JSON.parse(raw);
  } catch (ignored) {
    var data = {};
    raw.split("&").forEach(function(pair) {
      var parts = pair.split("=");
      var key = decodeURIComponent(parts[0] || "");
      var value = decodeURIComponent(parts.slice(1).join("=") || "");
      if (key) data[key] = value;
    });
    return data;
  }
}

function validateAdminPassword_(password) {
  if (!ADMIN_PASSWORD) throw new Error("Primero define ADMIN_PASSWORD en Apps Script.");
  if (String(password || "") !== String(ADMIN_PASSWORD)) throw new Error("Contrasena de administrador invalida.");
}

function spreadsheet_() {
  if (SPREADSHEET_ID) return SpreadsheetApp.openById(SPREADSHEET_ID);
  var activeSpreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!activeSpreadsheet) throw new Error("No hay hoja activa. Coloca el ID de tu Google Sheet en SPREADSHEET_ID.");
  return activeSpreadsheet;
}

function json_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}

function param_(e, key, fallback) {
  return e && e.parameter && e.parameter[key] ? String(e.parameter[key]) : fallback;
}

function sortByOrder_(a, b) {
  return number_(a.orden) - number_(b.orden) || clean_(a.nombre).localeCompare(clean_(b.nombre), "es");
}

function required_(value, label) {
  var output = clean_(value);
  if (!output) throw new Error("Falta el campo " + label);
  return output;
}

function clean_(value) { return String(value == null ? "" : value).trim(); }

function number_(value) {
  if (typeof value === "number" && isFinite(value)) return Math.max(0, Math.round(value));
  var parsed = Number(clean_(value).replace(/[^\d-]/g, ""));
  return isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function bool_(value) {
  if (typeof value === "boolean") return value;
  var normalized = clean_(value || "true").toLowerCase();
  return ["false", "0", "no", "inactivo", "inactive"].indexOf(normalized) === -1;
}

function slug_(value) {
  return clean_(value || "general")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "general";
}

function makeId_(prefix) { return prefix + "-" + Utilities.getUuid().toLowerCase(); }

function errorMessage_(error) {
  console.error(error);
  return error && error.message ? error.message : String(error);
}
