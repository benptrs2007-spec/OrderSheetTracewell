# Order Sheet — a Tracewell custom module

An Excel-style worksheet for a Tracewell tenant: **customers down the left, every
product across the top**, and each cell filled in automatically from the orders
that come in on the Orders page. Click any cell to see exactly which order lines
produced it; export the grid to CSV or paste it straight into Excel.

Built to the Tracewell Module Developer Kit contract. It is a **static HTML/JS page
on a different origin** — no backend, no build step, no sign-in flow of its own.
There is nothing to compile: the repo root *is* the deployment.

**Live module URL:** `https://benptrs2007-spec.github.io/OrderSheetTracewell/`

---

## Read this before you register the module: the CORS allowlist

This decides whether the module works at all, and the Module Developer Kit is out
of date on it. Every call the module makes carries an `Authorization` header,
which forces the browser to send a CORS **preflight**. If the module's origin is
not on the backend allowlist, the browser blocks the request before it is sent —
the page and the Keycard handoff still work, but no data arrives.

Measured against the live API on **2026-10-17**, on `OPTIONS /api/settings/site`
with `Origin: <origin>` and `Access-Control-Request-Headers: authorization`:

| Origin | Response |
|---|---|
| `https://trace-matrix.web.app` | `204` + `access-control-allow-origin` |
| `https://trace-matrix.firebaseapp.com` | `204` + `access-control-allow-origin` |
| `https://tracewell.ca` | `204` + `access-control-allow-origin` |
| `https://www.tracewell.ca` | `204` + `access-control-allow-origin` |
| `http://localhost:5173` | **`500`, no CORS headers** |
| `http://localhost:4000`, `http://localhost:5000` | **`500`, no CORS headers** |
| `https://benptrs2007-spec.github.io` | **`500`, no CORS headers** |
| `https://example.com` (control) | **`500`, no CORS headers** |

Two things follow, and the second is the surprise:

1. **A GitHub Pages origin is not allowed**, so this host cannot read tenant data
   until the backend allowlist changes.
2. **The dev-kit-recommended localhost workflow is not allowed either**, even
   though the dev kit lists `localhost:5000/5173/4000` as permitted. As deployed,
   the allowlist contains only the four production Tracewell domains. Treat the
   dev kit's CORS list as stale until the platform team confirms otherwise.

Watch the failure signature: a non-allowlisted origin gets **HTTP `500` "Internal
server error", not a clean 4xx**. So if the module reports a 500, suspect the
allowlist before suspecting the endpoint.

**What to ask the platform team for** — the origin only, no path, plus your tenant
name so they can verify you own it:

```
https://benptrs2007-spec.github.io
```

The allowlist is currently hardcoded in `core-logic/src/server.ts`. Worth asking
for `http://localhost:5173` to be restored at the same time if you want the local
dev loop back. The dev kit mentions a future change where a registered
`custom_modules.entry_url` auto-allows its own origin; **the measurement above
cannot rule that in or out**, because it only tests an unregistered origin. So the
cheapest next step is to register the module and click it: if that change has
shipped it will simply work, and if not the console names the blocked request.

---

## Files

| File | What it is |
|---|---|
| `index.html` | The module. All UI, fetch and rendering. |
| `matrix.js` | Pure pivot/aggregation logic (no DOM, no network). Loaded by `index.html`. |
| `module.json` | Manifest used when registering the module with Tracewell. |

## How it gets your data (and why it never asks you to sign in)

Tracewell hands the module a **Keycard** JWT in the URL fragment (`#k=…`) when the
user opens it from the nav. `index.html` picks that up on load, stores it under
`localStorage.module_keycard`, and immediately scrubs the fragment from the URL bar.

Every request then goes to the Tracewell REST API directly:

```
GET https://trace-matrix-api-315133380910.us-east1.run.app/api/operations/orders
    Authorization: Bearer <keycard>
```

Endpoints used:

| Purpose | Endpoint | Payload field |
|---|---|---|
| Tenant name / currency | `GET /api/settings/site` (falls back to `/api/settings`) | `settings` |
| Product columns | `GET /api/catalog/products` | `products` |
| Customer rows | `GET /api/partners/partners` | `partners` |
| Orders in range | `GET /api/operations/orders` | `orders` |
| Order line items | `GET /api/operations/orders/:id` | `items` |

Every Tracewell response wraps its payload once (`{ success, <name> }`), so the
code unwraps one level — and tolerates a bare array too, because the MCP tools
return the unwrapped form.

There is **no** `/api/auth/login` call, no Supabase, no login form, and the module
never calls `/api/mcp` at runtime. Opening the URL directly shows a
"open this module from Tracewell" gate instead of asking for credentials.

## Registering it

1. Open Tracewell → **Administration → Custom Modules → Add Module**.
2. `entry_url`: `https://benptrs2007-spec.github.io/OrderSheetTracewell/` (keep the
   trailing slash).
3. `visible_to`: at least `tenant_admin` (the bundled manifest uses
   `tenant_admin` + `staff`).
4. Save. **Order Sheet** appears in the sidebar under **Modules**.
5. Click it. Tracewell opens a new tab with `#k=<keycard>` appended; the module
   reads it and loads. Hard-refresh Tracewell (Ctrl/Cmd+Shift+R) first if your tab
   predates the module's registration.

Or register over REST as a tenant admin:

```bash
curl -X POST https://trace-matrix-api-315133380910.us-east1.run.app/api/custom-modules \
  -H "Authorization: Bearer <tenant_admin keycard>" \
  -H 'Content-Type: application/json' \
  -d @module.json
```

Keycards live about an hour. When one expires the module clears it and shows the
gate again — reopen it from the Tracewell nav. The module never tries to refresh a
Keycard itself.

## Running it locally

Modules must be served over `http://localhost:<port>` because `file://` cannot be
registered as an `entry_url` (other users cannot reach your filesystem). The dev
kit names **5000, 5173 or 4000** as allowlisted; the 2026-10-17 measurement above
found none of them returning CORS headers, so verify with the preflight check in
that section before assuming the local path works. `file://` still works for a
quick double-click glance at the layout.

```bash
python -m http.server 5173        # or:  npx serve -l 5173
```

Then register `http://localhost:5173/index.html` as the `entry_url` as above.

## Using the sheet

- **From / To** bound the orders that count, with quick ranges (today, 7d, this
  month, 30d, YTD, all). Defaults to the current month.
- **Units / $** switches every cell, row and column total between quantity and
  dollar value.
- **All products** keeps every sellable catalogue product as a column even before
  it has been ordered, so the sheet does not reshuffle as orders arrive. Turn it
  off to show only products that actually sold in the range.
- **All customers** lists every customer, including ones with no orders in range.
- **Live 30s** re-checks the orders page every 30 seconds and new orders drop into
  the grid. The tab also refreshes when you come back to it.
- **Click a cell** for the contributing order lines (date, order #, qty, price).
- **Export CSV** / **Copy for Excel** (tab-separated, pastes into cells).

Headers and the customer column stay frozen while you scroll, like a spreadsheet.

### How the grid is assembled

`GET /api/operations/orders` carries no line items, so for each order in the date
range the module fetches `GET /api/operations/orders/:id` — bounded to 6 requests
at a time, with a progress line. Those details are cached per order and keyed by a
fingerprint of `order_total | total_items | status`, so a live refresh only fetches
orders that are new or have changed. Rows are customers, columns are products
(grouped under a category band), and cells are the summed quantity or
quantity × unit price from every line in range.

Products that appear on an order but are not in the catalogue still get a column
(labelled *Not in catalogue*), so no value ever silently disappears.

## Development & verification

The module has **zero dependencies and no build step** — edit `index.html`, reload
the tab. `matrix.js` is deliberately DOM-free and network-free so the pivot can be
tested on its own.

The test suites used to develop this are **not in this repo**, because they run
against payloads captured from a live tenant (real customers, products and orders)
and that data must not be published. They lived alongside the module during
development:

- 26 unit checks on the pivot, filters and exports, cross-checked against a second
  independently written aggregation of the same data so a bug cannot agree with
  itself.
- 18 render checks in jsdom, loading the real `index.html` with `fetch` pointed at
  the captured payloads and asserting what reaches the DOM: the Keycard handoff and
  fragment scrub, one column per catalogue product under a category band, one row
  per customer, cell values, row/column/grand totals, drill-down, the metric
  switch, the category filter, and the gate path.

That testing settled two things worth knowing:

- **The order fetch is complete.** Pivoting every order the API returned produced a
  total that matched the platform's own per-product sales report for the same
  period exactly, so `list_orders` is not silently capped.
- **Orders store historical product names.** Line items keep the product name as it
  was when the order was placed, so renamed products would otherwise split into two
  columns. Cells are therefore aggregated by `productId` and labelled with the
  *current* catalogue name, so one product never appears under two headings.

## Limitations

- The module talks to the REST API with a **user** Keycard. An MCP token is not
  enough — MCP tokens are scoped to MCP and are rejected (`403 LOBBY SECURITY`) by
  everything under `/api/operations/*`.
- **GitHub Pages is static-only.** It serves the module but cannot proxy the
  Tracewell API, so the CORS allowlist entry above is unavoidable on this host.
- `GET /api/operations/orders` may be capped or paginated by the backend. The
  module renders whatever it receives and filters by date client-side; if older
  orders stop appearing in **All**, that is server-side paging, not a bug here.
- Filtering to one category narrows the sheet to that category, which also means
  the row and grand totals count only that category's lines.
- GitHub Pages serves the repo root, so everything committed here is public. No
  credentials, tokens or tenant data are committed.
