/* order-sheet/matrix.js
 * Pure data logic for the Tracewell "Order Sheet" module.
 *
 * No DOM, no fetch, no globals beyond one namespace — so the same file can be
 * loaded by index.html as a classic <script> (works from file:// too) and
 * required by Node for tests.
 *
 * Field names below were verified against live tenant data returned by the
 * Tracewell MCP tools (list_orders, get_order_details, manage_partners,
 * list_products), not guessed. See README.md.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.OrderSheet = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var UNKNOWN_PRODUCT = '__unknown_product__';
  var UNKNOWN_CUSTOMER = 'name:'; // prefix for order rows with no partner_id

  /* ---------------------------------------------------------------- utils */

  // Quantities/prices arrive as strings ("4.0000") or numbers. Nulls are "no
  // value", which in a spreadsheet must read as 0, never NaN.
  function num(value) {
    if (value === null || value === undefined || value === '') return 0;
    var n = typeof value === 'number' ? value : parseFloat(String(value).replace(/,/g, ''));
    return isFinite(n) ? n : 0;
  }

  // Tracewell REST wraps every payload as { success: true, <name>: <payload> }.
  // MCP tools return the bare array. Accept both, plus a defensive fallback.
  function unwrap(payload, key) {
    if (payload === null || payload === undefined) return [];
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload[key])) return payload[key];
    if (Array.isArray(payload.data)) return payload.data;
    for (var k in payload) {
      if (Object.prototype.hasOwnProperty.call(payload, k) && Array.isArray(payload[k])) {
        return payload[k];
      }
    }
    return [];
  }

  // Order dates are ISO instants ("2026-10-16T00:00:00.000Z") but represent a
  // calendar day. Compare on the literal date part so a tenant's timezone can
  // never shift an order into the wrong day.
  function orderDay(order) {
    var raw = order && (order.order_date || order.date);
    if (!raw) return '';
    return String(raw).slice(0, 10);
  }

  function customerKeyOf(order) {
    if (order.partner_id) return order.partner_id;
    // An order with no partner still has to land on a row.
    return UNKNOWN_CUSTOMER + (order.customer_name || 'Unknown customer');
  }

  /* ----------------------------------------------------------- normalizers */

  function normalizeOrders(payload) {
    return unwrap(payload, 'orders').map(function (o) {
      return {
        order_id: o.order_id || o.id,
        order_number: o.order_number || '',
        invoice_number: o.invoice_number || '',
        status: o.status || '',
        order_date: o.order_date || o.date || '',
        day: orderDay(o),
        customer_name: o.customer_name || '',
        partner_id: o.partner_id || null,
        total_items: num(o.total_items),
        order_total: num(o.order_total),
      };
    });
  }

  function normalizePartners(payload) {
    return unwrap(payload, 'partners').map(function (p) {
      return {
        id: p.id || p.partner_id,
        type: p.type || '',
        name: p.name || '',
      };
    });
  }

  function normalizeProducts(payload) {
    return unwrap(payload, 'products').map(function (p) {
      return {
        id: p.id || p.product_id,
        name: p.name || '',
        sku: p.sku || '',
        category: p.category || 'Uncategorised',
        unit_of_measure: p.unit_of_measure || '',
        standard_price: num(p.standard_price),
        we_sell: p.we_sell !== false,
        inactive: p.inactive === true,
      };
    });
  }

  // get_order_details returns { order, items }; the line array may also be
  // embedded on the order itself when the list endpoint inlines items.
  function normalizeItems(order, payload) {
    var items = unwrap(payload, 'items');
    if (!items.length) items = unwrap(payload, 'order_items');
    return items.map(function (it) {
      return {
        id: it.id || null,
        product_id: it.productId || it.product_id || UNKNOWN_PRODUCT,
        name: it.name || '',
        sku: it.sku || '',
        unit_of_measure: it.unit_of_measure || '',
        quantity: num(it.quantity),
        price_per_unit: num(it.pricePerUnit !== undefined ? it.pricePerUnit : it.price_per_unit),
        lot_number: it.lotNumber || it.lot_number || null,
        order_id: order.order_id,
        order_number: order.order_number,
        order_date: order.day || orderDay(order),
        customer_name: order.customer_name,
      };
    });
  }

  /* -------------------------------------------------------------- filters */

  function filterOrders(orders, opts) {
    opts = opts || {};
    var from = opts.from || '';
    var to = opts.to || '';
    var statuses = opts.statuses && opts.statuses.length ? opts.statuses : null;
    return orders.filter(function (o) {
      if (from && o.day && o.day < from) return false;
      if (to && o.day && o.day > to) return false;
      if (statuses && statuses.indexOf(o.status) === -1) return false;
      return true;
    });
  }

  /* --------------------------------------------------------------- matrix */

  /**
   * Build the customer × product order sheet.
   *
   * @param {Object}  input
   * @param {Array}   input.orders         normalized orders (already date-filtered)
   * @param {Object}  input.itemsByOrder   { [order_id]: Array<normalized item> }
   * @param {Array}   input.partners       normalized partners
   * @param {Array}   input.products       normalized products
   * @param {string}  [input.metric]       'units' (default) | 'amount'
   * @param {boolean} [input.allCustomers] list every customer, even with no orders
   * @param {boolean} [input.allProducts]  list every sellable product as a column
   * @param {string}  [input.category]     restrict product columns to one category
   */
  function buildMatrix(input) {
    var orders = input.orders || [];
    var itemsByOrder = input.itemsByOrder || {};
    var partners = input.partners || [];
    var products = input.products || [];
    var metric = input.metric === 'amount' ? 'amount' : 'units';
    var allCustomers = !!input.allCustomers;
    var allProducts = input.allProducts !== false; // default: full catalogue
    var category = input.category || '';

    var orderKeys = {};
    orders.forEach(function (o) { orderKeys[o.order_id] = true; });

    /* ---- columns: products across the top ---- */
    var colByKey = {};
    var colOrder = [];
    function addColumn(key, name, sku, categoryName, unit, sellable) {
      if (colByKey[key]) {
        // A real catalogue entry beats a placeholder created from a line item.
        if (sellable && !colByKey[key].fromCatalogue) {
          colByKey[key].name = name || colByKey[key].name;
          colByKey[key].sku = sku || colByKey[key].sku;
          colByKey[key].category = categoryName || colByKey[key].category;
          colByKey[key].unit = unit || colByKey[key].unit;
          colByKey[key].fromCatalogue = true;
        }
        return;
      }
      colByKey[key] = {
        key: key, name: name || '(unnamed product)', sku: sku || '',
        category: categoryName || 'Uncategorised', unit: unit || '',
        fromCatalogue: !!sellable,
      };
      colOrder.push(key);
    }

    // Every sellable product, independent of the category filter. A line item
    // for a product that is in the catalogue must keep its real name, category
    // and unit — even when the catalogue is not being listed in full.
    var catalogueIndex = {};
    products.forEach(function (p) {
      if (p.we_sell === false || p.inactive) return;
      catalogueIndex[p.id] = p;
    });

    if (allProducts) {
      products.forEach(function (p) {
        if (p.we_sell === false || p.inactive) return;
        if (category && p.category !== category) return;
        addColumn(p.id, p.name, p.sku, p.category, p.unit_of_measure, true);
      });
    }

    /* ---- rows: customers down the left ---- */
    var rowByKey = {};
    var rowOrder = [];
    function addRow(key, name, partnerId) {
      if (rowByKey[key]) {
        if (name && !rowByKey[key].name) rowByKey[key].name = name;
        return;
      }
      rowByKey[key] = {
        key: key, name: name || '(unnamed customer)', partner_id: partnerId || null,
        units: 0, amount: 0, orders: {}, lines: 0,
      };
      rowOrder.push(key);
    }

    if (allCustomers) {
      partners.forEach(function (p) {
        if (p.type && p.type !== 'customer') return;
        addRow(p.id, p.name, p.id);
      });
    }

    /* ---- cells: aggregate every line item ---- */
    var cells = Object.create(null);
    var colUnits = {};
    var colAmount = {};
    var grandUnits = 0;
    var grandAmount = 0;

    orders.forEach(function (o) {
      var rowKey = customerKeyOf(o);
      var items = itemsByOrder[o.order_id] || [];
      if (!items.length && !allCustomers && !rowByKey[rowKey]) {
        // Customer has an order but we could not read its lines (e.g. a 403 on
        // that one fetch). Still show the row so the sheet doesn't silently
        // drop a customer.
        addRow(rowKey, o.customer_name, o.partner_id);
      }
      if (!rowByKey[rowKey]) addRow(rowKey, o.customer_name, o.partner_id);
      rowByKey[rowKey].orders[o.order_id] = true;

      items.forEach(function (it) {
        var key = it.product_id || UNKNOWN_PRODUCT;
        var known = catalogueIndex[key];
        // Filtering to one category must not let the other categories sneak
        // back in through the order lines.
        if (known && category && known.category !== category) return;
        if (!colByKey[key]) {
          if (known) {
            // e.g. allProducts:false — the column comes from a sale, but it is
            // still a real catalogue product and keeps its category.
            addColumn(key, known.name, known.sku, known.category, known.unit_of_measure, true);
          } else if (!category) {
            // Genuinely not in the catalogue: keep the value visible rather
            // than dropping it. With a category filter on, it cannot be said to
            // belong to the selected category, so it is left out.
            addColumn(key, it.name, it.sku, 'Not in catalogue', it.unit_of_measure, false);
          } else {
            return;
          }
        }
        var ck = rowKey + '\u0000' + key;
        var cell = cells[ck];
        if (!cell) {
          cell = cells[ck] = { keys: [rowKey, key], units: 0, amount: 0, lines: [] };
        }
        var amount = it.quantity * it.price_per_unit;
        cell.units += it.quantity;
        cell.amount += amount;
        cell.lines.push({
          order_id: it.order_id,
          order_number: it.order_number,
          order_date: it.order_date,
          quantity: it.quantity,
          price_per_unit: it.price_per_unit,
          amount: amount,
          lot_number: it.lot_number,
        });
        rowByKey[rowKey].units += it.quantity;
        rowByKey[rowKey].amount += amount;
        rowByKey[rowKey].lines += 1;
        colUnits[key] = (colUnits[key] || 0) + it.quantity;
        colAmount[key] = (colAmount[key] || 0) + amount;
        grandUnits += it.quantity;
        grandAmount += amount;
      });
    });

    /* ---- shape for the UI ---- */
    var columns = colOrder.map(function (key) {
      var c = colByKey[key];
      if (!allProducts && !c.fromCatalogue && !colUnits[key] && !colAmount[key]) return null;
      return {
        key: c.key, name: c.name, sku: c.sku, category: c.category, unit: c.unit,
        units: colUnits[key] || 0, amount: colAmount[key] || 0,
      };
    }).filter(Boolean);

    // Keep catalogue ordering: by category, then name (Excel-ish A→Z within
    // each block so the sheet is stable between refreshes).
    columns.sort(function (a, b) {
      if (a.category !== b.category) return String(a.category).localeCompare(String(b.category));
      return String(a.name).localeCompare(String(b.name));
    });

    var rows = rowOrder.map(function (key) {
      var r = rowByKey[key];
      return {
        key: r.key, name: r.name, partner_id: r.partner_id,
        units: r.units, amount: r.amount,
        orders: Object.keys(r.orders).length,
        lines: r.lines,
      };
    }).filter(function (r) {
      // With allCustomers off, rows with no activity in range are noise.
      if (allCustomers) return true;
      return r.lines > 0 || orders.some(function (o) { return customerKeyOf(o) === r.key; });
    });

    rows.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });

    var columnGroups = [];
    columns.forEach(function (c) {
      var last = columnGroups[columnGroups.length - 1];
      if (last && last.category === c.category) last.span += 1;
      else columnGroups.push({ category: c.category, span: 1 });
    });

    return {
      metric: metric,
      columns: columns,
      columnGroups: columnGroups,
      rows: rows,
      cells: cells,
      columnTotals: { units: colUnits, amount: colAmount },
      grandTotal: { units: grandUnits, amount: grandAmount },
      ordersInRange: orders.length,
      productColumns: columns.length,
      customerRows: rows.length,
    };
  }

  function cellValue(matrix, rowKey, colKey) {
    var cell = matrix.cells[rowKey + '\u0000' + colKey];
    if (!cell) return 0;
    return matrix.metric === 'amount' ? cell.amount : cell.units;
  }

  function cellDetail(matrix, rowKey, colKey) {
    var cell = matrix.cells[rowKey + '\u0000' + colKey];
    if (!cell) return null;
    var lines = cell.lines.slice().sort(function (a, b) {
      return String(a.order_date).localeCompare(String(b.order_date));
    });
    return { units: cell.units, amount: cell.amount, lines: lines };
  }

  /* --------------------------------------------------------------- export */

  function round2(n) { return Math.round(n * 100) / 100; }

  function valueFor(matrix, rowKey, colKey) {
    var v = cellValue(matrix, rowKey, colKey);
    return matrix.metric === 'amount' ? round2(v) : round2(v);
  }

  function rowTotal(matrix, row) {
    return matrix.metric === 'amount' ? round2(row.amount) : round2(row.units);
  }

  function grandTotal(matrix) {
    return matrix.metric === 'amount'
      ? round2(matrix.grandTotal.amount)
      : round2(matrix.grandTotal.units);
  }

  function columnHeader(c) {
    return matrix_safe(c.name) + (c.unit ? ' (' + c.unit + ')' : '');
  }
  function matrix_safe(s) { return String(s == null ? '' : s); }

  function csvCell(v) {
    var s = String(v == null ? '' : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCSV(matrix) {
    var head = ['Customer'].concat(matrix.columns.map(columnHeader))
      .concat([matrix.metric === 'amount' ? 'TOTAL ($)' : 'TOTAL']);
    var lines = [head.map(csvCell).join(',')];
    matrix.rows.forEach(function (r) {
      var row = [r.name];
      matrix.columns.forEach(function (c) { row.push(valueFor(matrix, r.key, c.key)); });
      row.push(rowTotal(matrix, r));
      lines.push(row.map(csvCell).join(','));
    });
    var totals = ['TOTAL'];
    matrix.columns.forEach(function (c) {
      var v = matrix.metric === 'amount' ? matrix.columnTotals.amount[c.key] : matrix.columnTotals.units[c.key];
      totals.push(round2(v || 0));
    });
    totals.push(grandTotal(matrix));
    lines.push(totals.map(csvCell).join(','));
    return lines.join('\n');
  }

  // Tab-separated: the format Excel/Sheets paste straight into cells.
  function toTSV(matrix) {
    return toCSV(matrix).split('\n').map(function (line) {
      // Re-parse the CSV row so quoted commas survive the tab swap.
      var out = [];
      var cur = '';
      var inQ = false;
      for (var i = 0; i < line.length; i++) {
        var ch = line[i];
        if (inQ) {
          if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
          else if (ch === '"') inQ = false;
          else cur += ch;
        } else if (ch === '"') inQ = true;
        else if (ch === ',') { out.push(cur); cur = ''; }
        else cur += ch;
      }
      out.push(cur);
      return out.join('\t');
    }).join('\n');
  }

  return {
    num: num,
    unwrap: unwrap,
    orderDay: orderDay,
    customerKeyOf: customerKeyOf,
    normalizeOrders: normalizeOrders,
    normalizePartners: normalizePartners,
    normalizeProducts: normalizeProducts,
    normalizeItems: normalizeItems,
    filterOrders: filterOrders,
    buildMatrix: buildMatrix,
    cellValue: cellValue,
    cellDetail: cellDetail,
    toCSV: toCSV,
    toTSV: toTSV,
    round2: round2,
    rowTotal: rowTotal,
    grandTotal: grandTotal,
    UNKNOWN_PRODUCT: UNKNOWN_PRODUCT,
  };
});
