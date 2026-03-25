import csv
import io
import os
import sqlite3
import zipfile
import xml.etree.ElementTree as ET
import hashlib
import secrets
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse
import cgi

DB_PATH = os.path.join(os.path.dirname(__file__), "app.db")
VENDOR_CATEGORIES = ["pipe", "civil", "steel", "pipe fab", "support fab", "grout", "tubing"]
SESSIONS = {}


def conn():
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    return c


def init_db():
    c = conn()
    cur = c.cursor()
    cur.executescript(
        """
        CREATE TABLE IF NOT EXISTS vendors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            email TEXT,
            phone TEXT,
            categories TEXT,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS material_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            item_code TEXT NOT NULL UNIQUE,
            description TEXT NOT NULL,
            material_type TEXT NOT NULL,
            uom TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS rfqs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rfq_no TEXT NOT NULL UNIQUE,
            project_name TEXT NOT NULL,
            due_date TEXT,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS rfq_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rfq_id INTEGER NOT NULL,
            material_item_id INTEGER NOT NULL,
            size_1 TEXT,
            size_2 TEXT,
            thk_1 TEXT,
            thk_2 TEXT,
            qty REAL NOT NULL,
            notes TEXT,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(rfq_id) REFERENCES rfqs(id),
            FOREIGN KEY(material_item_id) REFERENCES material_items(id)
        );

        CREATE TABLE IF NOT EXISTS quotes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rfq_item_id INTEGER NOT NULL,
            vendor_id INTEGER NOT NULL,
            unit_price REAL NOT NULL,
            lead_days INTEGER,
            quoted_at TEXT NOT NULL,
            FOREIGN KEY(rfq_item_id) REFERENCES rfq_items(id),
            FOREIGN KEY(vendor_id) REFERENCES vendors(id),
            UNIQUE(rfq_item_id, vendor_id)
        );

        CREATE TABLE IF NOT EXISTS purchase_orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            po_no TEXT NOT NULL UNIQUE,
            vendor_id INTEGER NOT NULL,
            rfq_id INTEGER,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(vendor_id) REFERENCES vendors(id),
            FOREIGN KEY(rfq_id) REFERENCES rfqs(id)
        );

        CREATE TABLE IF NOT EXISTS po_lines (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            po_id INTEGER NOT NULL,
            material_item_id INTEGER NOT NULL,
            size_1 TEXT,
            size_2 TEXT,
            thk_1 TEXT,
            thk_2 TEXT,
            qty_ordered REAL NOT NULL,
            unit_price REAL NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(po_id) REFERENCES purchase_orders(id),
            FOREIGN KEY(material_item_id) REFERENCES material_items(id)
        );

        CREATE TABLE IF NOT EXISTS receipts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            po_line_id INTEGER NOT NULL,
            qty_received REAL NOT NULL,
            warehouse TEXT NOT NULL,
            location TEXT NOT NULL,
            osd_status TEXT NOT NULL,
            osd_notes TEXT,
            received_at TEXT NOT NULL,
            FOREIGN KEY(po_line_id) REFERENCES po_lines(id)
        );

        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            action TEXT NOT NULL,
            entity_type TEXT NOT NULL,
            entity_id TEXT,
            details TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
        """
    )
    cur.execute("PRAGMA table_info(rfq_items)")
    existing_cols = {row[1] for row in cur.fetchall()}
    for col in ["size_1", "size_2", "thk_1", "thk_2"]:
        if col not in existing_cols:
            cur.execute(f"ALTER TABLE rfq_items ADD COLUMN {col} TEXT")
    if "updated_at" not in existing_cols:
        cur.execute("ALTER TABLE rfq_items ADD COLUMN updated_at TEXT")
    cur.execute("UPDATE rfq_items SET updated_at = COALESCE(updated_at, ?) WHERE updated_at IS NULL OR updated_at = ''", (now_iso(),))
    cur.execute("PRAGMA table_info(po_lines)")
    po_line_cols = {row[1] for row in cur.fetchall()}
    for col in ["size_1", "size_2", "thk_1", "thk_2"]:
        if col not in po_line_cols:
            cur.execute(f"ALTER TABLE po_lines ADD COLUMN {col} TEXT")
    if "updated_at" not in po_line_cols:
        cur.execute("ALTER TABLE po_lines ADD COLUMN updated_at TEXT")
    cur.execute("UPDATE po_lines SET updated_at = COALESCE(updated_at, ?) WHERE updated_at IS NULL OR updated_at = ''", (now_iso(),))
    cur.execute("PRAGMA table_info(purchase_orders)")
    po_cols = {row[1] for row in cur.fetchall()}
    if "updated_at" not in po_cols:
        cur.execute("ALTER TABLE purchase_orders ADD COLUMN updated_at TEXT")
    cur.execute("UPDATE purchase_orders SET updated_at = COALESCE(updated_at, created_at, ?) WHERE updated_at IS NULL OR updated_at = ''", (now_iso(),))
    cur.execute("PRAGMA table_info(vendors)")
    vendor_cols = {row[1] for row in cur.fetchall()}
    if "categories" not in vendor_cols:
        cur.execute("ALTER TABLE vendors ADD COLUMN categories TEXT")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_po_po_no ON purchase_orders(po_no)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_po_vendor_id ON purchase_orders(vendor_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_po_rfq_id ON purchase_orders(rfq_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_orders(status)")
    cur.execute("SELECT id FROM users WHERE username='admin'")
    if not cur.fetchone():
        cur.execute(
            "INSERT INTO users(username,password_hash,role,created_at) VALUES (?,?,?,?)",
            ("admin", hashlib.sha256("admin123".encode("utf-8")).hexdigest(), "admin", now_iso())
        )
    c.commit()
    c.close()


def now_iso():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _xlsx_col_to_index(cell_ref):
    letters = ""
    for ch in cell_ref:
        if ch.isalpha():
            letters += ch
        else:
            break
    idx = 0
    for ch in letters.upper():
        idx = idx * 26 + (ord(ch) - ord("A") + 1)
    return max(idx - 1, 0)


def _xlsx_sheet_rows(xlsx_bytes):
    ns = {"x": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    rows_out = []
    with zipfile.ZipFile(io.BytesIO(xlsx_bytes)) as zf:
        shared = []
        if "xl/sharedStrings.xml" in zf.namelist():
            sroot = ET.fromstring(zf.read("xl/sharedStrings.xml"))
            for si in sroot.findall("x:si", ns):
                text_parts = [t.text or "" for t in si.findall(".//x:t", ns)]
                shared.append("".join(text_parts))

        sheet_candidates = sorted([n for n in zf.namelist() if n.startswith("xl/worksheets/") and n.endswith(".xml")])
        if not sheet_candidates:
            return []
        sheet_path = sheet_candidates[0]

        root = ET.fromstring(zf.read(sheet_path))
        for row in root.findall(".//x:sheetData/x:row", ns):
            cell_map = {}
            max_idx = -1
            for c in row.findall("x:c", ns):
                ref = c.attrib.get("r", "")
                cidx = _xlsx_col_to_index(ref) if ref else len(cell_map)
                ctype = c.attrib.get("t", "")
                value = ""
                if ctype == "inlineStr":
                    t = c.find("x:is/x:t", ns)
                    value = t.text if t is not None and t.text is not None else ""
                else:
                    v = c.find("x:v", ns)
                    raw = v.text if v is not None and v.text is not None else ""
                    if ctype == "s":
                        try:
                            value = shared[int(raw)]
                        except Exception:
                            value = raw
                    else:
                        value = raw
                cell_map[cidx] = value.strip()
                if cidx > max_idx:
                    max_idx = cidx

            if max_idx < 0:
                continue
            row_vals = [cell_map.get(i, "") for i in range(max_idx + 1)]
            rows_out.append(row_vals)
    return rows_out


def parse_uploaded_table(form):
    text = form.get("csv_text", "")
    upload = form.get("csv_file")

    if upload is not None and getattr(upload, "file", None):
        filename = (upload.filename or "").lower()
        blob = upload.file.read()
        if filename.endswith(".xlsx"):
            xrows = _xlsx_sheet_rows(blob)
            if not xrows:
                return []
            # Find first non-empty row as header row.
            header_row = None
            data_start = 1
            for idx, r in enumerate(xrows):
                if any((v or "").strip() for v in r):
                    header_row = r
                    data_start = idx + 1
                    break
            if not header_row:
                return []

            headers = [h.strip().lower() for h in header_row]
            out = []
            for vals in xrows[data_start:]:
                if not any((v or "").strip() for v in vals):
                    continue
                row = {}
                for i, h in enumerate(headers):
                    if h:
                        row[h] = vals[i].strip() if i < len(vals) else ""
                out.append(row)
            return out
        text = blob.decode("utf-8")

    if not text.strip():
        return []
    rows = []
    for r in csv.DictReader(io.StringIO(text)):
        nr = {}
        for k, v in r.items():
            if k is None:
                continue
            nr[k.strip().lower()] = (v or "").strip()
        rows.append(nr)
    return rows


def pick(row, *keys):
    for k in keys:
        if k in row and str(row.get(k, "")).strip():
            return str(row.get(k, "")).strip()
    return ""


def page(title, body):
    return f"""<!doctype html>
<html>
<head>
  <meta charset=\"utf-8\" />
  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />
  <title>{title}</title>
    <style>
    body {{ font-family: Segoe UI, sans-serif; margin: 0; background: #f6f8fb; color: #1f2937; }}
    .wrap {{ max-width: 1100px; margin: 0 auto; padding: 24px; }}
    nav a {{ margin-right: 14px; text-decoration: none; color: #0f4c81; font-weight: 600; }}
    .card {{ background: white; border-radius: 10px; padding: 18px; margin: 14px 0; box-shadow: 0 1px 3px rgba(0,0,0,.08); }}
    table {{ width: 100%; border-collapse: collapse; font-size: 14px; }}
    th, td {{ border-bottom: 1px solid #e5e7eb; padding: 8px; text-align: left; }}
    input, select, textarea, button {{ padding: 8px; margin: 4px 0; }}
    input, select, textarea {{ width: 100%; box-sizing: border-box; }}
    .grid {{ display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }}
    button {{ background: #0f4c81; color: white; border: 0; border-radius: 6px; cursor: pointer; }}
    .btn {{ border-radius: 6px; padding: 8px 12px; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; min-width: 96px; height: 34px; box-sizing: border-box; font-weight: 600; }}
    .btn-secondary {{ background: #374151; color: white; }}
    .btn-danger {{ background: #b91c1c; color: white; border: 0; }}
    .actions {{ display: flex; gap: 8px; align-items: center; }}
    .muted {{ color: #6b7280; font-size: 13px; }}
  </style>
</head>
<body>
<div class=\"wrap\">
  <nav>
    <a href=\"/\">Dashboard</a>
    <a href=\"/vendors\">Vendors</a>
    <a href=\"/rfq\">RFQs</a>
    <a href=\"/po\">POs</a>
    <a href=\"/receive\">Receiving</a>
    <a href=\"/inventory\">Inventory</a>
    <a href=\"/logout\">Logout</a>
  </nav>
  {body}
</div>
</body>
</html>
"""


def parse_post(handler):
    ctype, _ = cgi.parse_header(handler.headers.get("content-type", ""))
    if ctype == "multipart/form-data":
        fs = cgi.FieldStorage(fp=handler.rfile, headers=handler.headers, environ={"REQUEST_METHOD": "POST"})
        out = {}
        for key in fs.keys():
            field = fs[key]
            if isinstance(field, list):
                out[key] = [f.value for f in field]
            else:
                if field.filename:
                    out[key] = field
                else:
                    out[key] = field.value
        return out
    length = int(handler.headers.get("content-length", "0"))
    raw = handler.rfile.read(length).decode("utf-8")
    data = parse_qs(raw)
    out = {}
    for k, v in data.items():
        out[k] = v if len(v) > 1 else v[0]
    return out


def as_list(val):
    if val is None:
        return []
    if isinstance(val, list):
        return [str(x).strip() for x in val if str(x).strip()]
    txt = str(val).strip()
    return [txt] if txt else []


def normalize_vendor_categories(raw_vals):
    vals = [v.lower().strip() for v in as_list(raw_vals)]
    out = []
    for c in VENDOR_CATEGORIES:
        if c in vals:
            out.append(c)
    return ",".join(out)


def hash_password(password):
    return hashlib.sha256(password.encode("utf-8")).hexdigest()


def parse_cookie(header):
    out = {}
    if not header:
        return out
    parts = header.split(";")
    for p in parts:
        if "=" in p:
            k, v = p.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def audit(cur, user_id, action, entity_type, entity_id="", details=""):
    cur.execute(
        "INSERT INTO audit_log(user_id,action,entity_type,entity_id,details,created_at) VALUES (?,?,?,?,?,?)",
        (user_id, action, entity_type, str(entity_id or ""), details, now_iso())
    )


class App(BaseHTTPRequestHandler):
    def respond(self, html, status=HTTPStatus.OK):
        payload = html.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def redirect(self, location):
        self.send_response(HTTPStatus.SEE_OTHER)
        self.send_header("Location", location)
        self.end_headers()

    def current_user(self):
        cookies = parse_cookie(self.headers.get("Cookie", ""))
        token = cookies.get("session_token", "")
        return SESSIONS.get(token)

    def require_role(self, user, allowed_roles):
        return user and user.get("role") in allowed_roles

    def set_session_and_redirect(self, user):
        token = secrets.token_hex(24)
        SESSIONS[token] = {"id": user["id"], "username": user["username"], "role": user["role"]}
        self.send_response(HTTPStatus.SEE_OTHER)
        self.send_header("Set-Cookie", f"session_token={token}; Path=/; HttpOnly")
        self.send_header("Location", "/")
        self.end_headers()

    def clear_session_and_redirect(self):
        cookies = parse_cookie(self.headers.get("Cookie", ""))
        token = cookies.get("session_token", "")
        if token in SESSIONS:
            del SESSIONS[token]
        self.send_response(HTTPStatus.SEE_OTHER)
        self.send_header("Set-Cookie", "session_token=; Path=/; Max-Age=0; HttpOnly")
        self.send_header("Location", "/login")
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/login":
            self.respond(self.login_page())
            return
        if path == "/logout":
            self.clear_session_and_redirect()
            return
        user = self.current_user()
        if not user:
            self.redirect("/login")
            return
        if path == "/":
            self.respond(self.dashboard())
        elif path == "/vendors":
            self.respond(self.vendors_page())
        elif path.startswith("/vendors/") and path.endswith("/edit"):
            self.respond(self.vendor_edit_page(path.split("/")[2]))
        elif path == "/rfq":
            self.respond(self.rfq_page())
        elif path.startswith("/rfq_item/") and path.endswith("/edit"):
            self.respond(self.rfq_item_edit_page(path.split("/")[2]))
        elif path.startswith("/rfq_item/") and path.endswith("/quotes"):
            self.respond(self.rfq_item_quotes_page(path.split("/")[2]))
        elif path.startswith("/po_line/") and path.endswith("/edit"):
            self.respond(self.po_line_edit_page(path.split("/")[2]))
        elif path.startswith("/po/") and path.endswith("/edit"):
            self.respond(self.po_edit_page(path.split("/")[2]))
        elif path.startswith("/rfq/"):
            self.respond(self.rfq_detail(path.split("/")[-1]))
        elif path == "/po":
            self.respond(self.po_page())
        elif path == "/receive":
            self.respond(self.receive_page())
        elif path == "/inventory":
            self.respond(self.inventory_page())
        else:
            self.respond(page("Not Found", "<h2>Not Found</h2>"), status=HTTPStatus.NOT_FOUND)

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/login":
            form = parse_post(self)
            c = conn(); cur = c.cursor()
            cur.execute("SELECT id, username, role, password_hash FROM users WHERE username=?", (form.get("username", "").strip(),))
            u = cur.fetchone()
            c.close()
            if u and u["password_hash"] == hash_password(form.get("password", "")):
                self.set_session_and_redirect(u)
                return
            self.respond(self.login_page("Invalid username or password"), status=HTTPStatus.UNAUTHORIZED)
            return

        user = self.current_user()
        if not user:
            self.redirect("/login")
            return
        form = parse_post(self)
        c = conn()
        cur = c.cursor()

        try:
            if path == "/vendors/add":
                if not self.require_role(user, ["admin", "buyer"]):
                    self.respond(page("Forbidden", "<h2>Forbidden</h2>"), status=HTTPStatus.FORBIDDEN); return
                cats = normalize_vendor_categories(form.get("categories"))
                cur.execute(
                    "INSERT INTO vendors(name,email,phone,categories,created_at) VALUES (?,?,?,?,?)",
                    (form.get("name",""), form.get("email",""), form.get("phone",""), cats, now_iso())
                )
                audit(cur, user["id"], "create", "vendor", cur.lastrowid, form.get("name",""))
                c.commit()
                self.redirect("/vendors")
                return

            if path == "/vendors/update":
                if not self.require_role(user, ["admin", "buyer"]):
                    self.respond(page("Forbidden", "<h2>Forbidden</h2>"), status=HTTPStatus.FORBIDDEN); return
                vendor_id = int(form.get("vendor_id"))
                cats = normalize_vendor_categories(form.get("categories"))
                cur.execute(
                    "UPDATE vendors SET name=?, email=?, phone=?, categories=? WHERE id=?",
                    (form.get("name",""), form.get("email",""), form.get("phone",""), cats, vendor_id)
                )
                audit(cur, user["id"], "update", "vendor", vendor_id, form.get("name",""))
                c.commit()
                self.redirect("/vendors")
                return

            if path == "/rfq/add":
                if not self.require_role(user, ["admin", "buyer"]):
                    self.respond(page("Forbidden", "<h2>Forbidden</h2>"), status=HTTPStatus.FORBIDDEN); return
                cur.execute("INSERT INTO rfqs(rfq_no,project_name,due_date,status,created_at) VALUES (?,?,?,?,?)", (form.get("rfq_no",""), form.get("project_name",""), form.get("due_date",""), "OPEN", now_iso()))
                audit(cur, user["id"], "create", "rfq", cur.lastrowid, form.get("rfq_no",""))
                c.commit()
                self.redirect(f"/rfq/{cur.lastrowid}")
                return

            if path.startswith("/rfq/") and path.endswith("/upload"):
                if not self.require_role(user, ["admin", "buyer"]):
                    self.respond(page("Forbidden", "<h2>Forbidden</h2>"), status=HTTPStatus.FORBIDDEN); return
                rfq_id = int(path.split("/")[2])
                rows = parse_uploaded_table(form)
                if not rows:
                    raise ValueError("No rows found. Confirm headers and data in CSV/XLSX.")
                for r in rows:
                    item_code = r.get("item_code","").strip()
                    desc = r.get("description","").strip()
                    mtype = r.get("material_type","misc").strip() or "misc"
                    uom = r.get("uom","EA").strip() or "EA"
                    size_1 = r.get("size_1","").strip()
                    size_2 = r.get("size_2","").strip()
                    thk_1 = r.get("thk_1","").strip()
                    thk_2 = r.get("thk_2","").strip()
                    qty = float(r.get("qty","0") or 0)
                    notes = r.get("notes","").strip()
                    if not item_code or qty <= 0:
                        continue
                    cur.execute("SELECT id FROM material_items WHERE item_code=?", (item_code,))
                    ex = cur.fetchone()
                    if ex:
                        item_id = ex[0]
                    else:
                        cur.execute("INSERT INTO material_items(item_code,description,material_type,uom,created_at) VALUES (?,?,?,?,?)", (item_code, desc or item_code, mtype, uom, now_iso()))
                        item_id = cur.lastrowid
                    cur.execute(
                        "INSERT INTO rfq_items(rfq_id,material_item_id,size_1,size_2,thk_1,thk_2,qty,notes,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
                        (rfq_id, item_id, size_1, size_2, thk_1, thk_2, qty, notes, now_iso())
                    )
                audit(cur, user["id"], "import", "rfq_items", rfq_id, f"rows={len(rows)}")
                c.commit()
                self.redirect(f"/rfq/{rfq_id}")
                return

            if path == "/quote/add":
                if not self.require_role(user, ["admin", "buyer"]):
                    self.respond(page("Forbidden", "<h2>Forbidden</h2>"), status=HTTPStatus.FORBIDDEN); return
                cur.execute(
                    "INSERT OR REPLACE INTO quotes(rfq_item_id,vendor_id,unit_price,lead_days,quoted_at) VALUES (?,?,?,?,?)",
                    (int(form.get("rfq_item_id")), int(form.get("vendor_id")), float(form.get("unit_price")), int(form.get("lead_days") or 0), now_iso())
                )
                audit(cur, user["id"], "upsert", "quote", form.get("rfq_item_id",""), f"vendor={form.get('vendor_id')}")
                c.commit()
                self.redirect(f"/rfq/{form.get('rfq_id')}")
                return

            if path == "/rfq_item/update":
                if not self.require_role(user, ["admin", "buyer"]):
                    self.respond(page("Forbidden", "<h2>Forbidden</h2>"), status=HTTPStatus.FORBIDDEN); return
                rfq_item_id = int(form.get("rfq_item_id"))
                rfq_id = int(form.get("rfq_id"))
                expected_updated_at = form.get("updated_at", "")
                cur.execute("SELECT material_item_id FROM rfq_items WHERE id=?", (rfq_item_id,))
                rec = cur.fetchone()
                if not rec:
                    raise ValueError("RFQ item not found")
                material_item_id = rec[0]

                item_code = form.get("item_code", "").strip()
                description = form.get("description", "").strip() or item_code
                material_type = form.get("material_type", "").strip() or "misc"
                uom = form.get("uom", "").strip() or "EA"
                size_1 = form.get("size_1", "").strip()
                size_2 = form.get("size_2", "").strip()
                thk_1 = form.get("thk_1", "").strip()
                thk_2 = form.get("thk_2", "").strip()
                qty = float(form.get("qty", "0") or 0)
                notes = form.get("notes", "").strip()
                if not item_code or qty <= 0:
                    raise ValueError("Item code and qty > 0 are required")

                cur.execute(
                    "UPDATE material_items SET item_code=?, description=?, material_type=?, uom=? WHERE id=?",
                    (item_code, description, material_type, uom, material_item_id)
                )
                cur.execute(
                    "UPDATE rfq_items SET size_1=?, size_2=?, thk_1=?, thk_2=?, qty=?, notes=?, updated_at=? WHERE id=? AND updated_at=?",
                    (size_1, size_2, thk_1, thk_2, qty, notes, now_iso(), rfq_item_id, expected_updated_at)
                )
                if cur.rowcount == 0:
                    raise ValueError("This RFQ item was modified by another user. Refresh and try again.")
                audit(cur, user["id"], "update", "rfq_item", rfq_item_id, item_code)
                c.commit()
                self.redirect(f"/rfq/{rfq_id}")
                return

            if path == "/rfq_item/delete":
                if not self.require_role(user, ["admin", "buyer"]):
                    self.respond(page("Forbidden", "<h2>Forbidden</h2>"), status=HTTPStatus.FORBIDDEN); return
                rfq_item_id = int(form.get("rfq_item_id"))
                rfq_id = int(form.get("rfq_id"))
                cur.execute("DELETE FROM quotes WHERE rfq_item_id=?", (rfq_item_id,))
                cur.execute("DELETE FROM rfq_items WHERE id=?", (rfq_item_id,))
                audit(cur, user["id"], "delete", "rfq_item", rfq_item_id, "")
                c.commit()
                self.redirect(f"/rfq/{rfq_id}")
                return

            if path.startswith("/rfq/") and path.endswith("/quotes_upload"):
                if not self.require_role(user, ["admin", "buyer"]):
                    self.respond(page("Forbidden", "<h2>Forbidden</h2>"), status=HTTPStatus.FORBIDDEN); return
                rfq_id = int(path.split("/")[2])
                rows = parse_uploaded_table(form)
                if not rows:
                    raise ValueError("No rows found. Confirm headers and data in CSV/XLSX.")
                for r in rows:
                    vendor_name = (r.get("vendor_name") or "").strip()
                    item_code = (r.get("item_code") or "").strip()
                    if not vendor_name or not item_code:
                        continue

                    unit_price_val = (r.get("unit_price") or "").strip()
                    if not unit_price_val:
                        continue

                    unit_price = float(unit_price_val)
                    lead_days = int((r.get("lead_days") or "0").strip() or 0)

                    cur.execute("SELECT id FROM vendors WHERE name=?", (vendor_name,))
                    v = cur.fetchone()
                    if v:
                        vendor_id = v[0]
                    else:
                        cur.execute(
                            "INSERT INTO vendors(name,email,phone,created_at) VALUES (?,?,?,?)",
                            (vendor_name, "", "", now_iso())
                        )
                        vendor_id = cur.lastrowid

                    cur.execute(
                        """
                        SELECT ri.id
                        FROM rfq_items ri
                        JOIN material_items mi ON mi.id = ri.material_item_id
                        WHERE ri.rfq_id=? AND mi.item_code=?
                        """,
                        (rfq_id, item_code)
                    )
                    rfq_item = cur.fetchone()
                    if not rfq_item:
                        continue

                    cur.execute(
                        "INSERT OR REPLACE INTO quotes(rfq_item_id,vendor_id,unit_price,lead_days,quoted_at) VALUES (?,?,?,?,?)",
                        (rfq_item[0], vendor_id, unit_price, lead_days, now_iso())
                    )

                c.commit()
                self.redirect(f"/rfq/{rfq_id}")
                return

            if path == "/po/create":
                if not self.require_role(user, ["admin", "buyer"]):
                    self.respond(page("Forbidden", "<h2>Forbidden</h2>"), status=HTTPStatus.FORBIDDEN); return
                rfq_id = int(form.get("rfq_id"))
                vendor_id = int(form.get("vendor_id"))
                po_no = form.get("po_no")
                cur.execute("SELECT COUNT(*) FROM rfq_items WHERE rfq_id=?", (rfq_id,))
                total_items = cur.fetchone()[0]
                if total_items == 0:
                    raise ValueError("Cannot issue PO: RFQ has no items.")

                cur.execute("INSERT INTO purchase_orders(po_no,vendor_id,rfq_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?)", (po_no, vendor_id, rfq_id, "OPEN", now_iso(), now_iso()))
                po_id = cur.lastrowid
                cur.execute(
                    """
                    SELECT ri.material_item_id, ri.size_1, ri.size_2, ri.thk_1, ri.thk_2, ri.qty, q.unit_price
                    FROM rfq_items ri
                    JOIN quotes q ON q.rfq_item_id = ri.id
                    WHERE ri.rfq_id=? AND q.vendor_id=?
                    """,
                    (rfq_id, vendor_id)
                )
                for row in cur.fetchall():
                    cur.execute(
                        "INSERT INTO po_lines(po_id,material_item_id,size_1,size_2,thk_1,thk_2,qty_ordered,unit_price,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
                        (po_id, row[0], row[1], row[2], row[3], row[4], row[5], row[6], now_iso())
                    )
                cur.execute("SELECT COUNT(*) FROM po_lines WHERE po_id=?", (po_id,))
                if cur.fetchone()[0] == 0:
                    raise ValueError("No PO lines created. Selected vendor has no quoted items on this RFQ.")

                # Auto-close RFQ when every RFQ item has been issued on at least one PO line.
                cur.execute(
                    """
                    SELECT COUNT(DISTINCT ri.id)
                    FROM rfq_items ri
                    JOIN purchase_orders po ON po.rfq_id = ri.rfq_id
                    JOIN po_lines pl ON pl.po_id = po.id AND pl.material_item_id = ri.material_item_id
                    WHERE ri.rfq_id=?
                    """,
                    (rfq_id,)
                )
                issued_items = cur.fetchone()[0]
                new_status = "CLOSED" if total_items > 0 and issued_items >= total_items else "OPEN"
                cur.execute("UPDATE rfqs SET status=? WHERE id=?", (new_status, rfq_id))

                audit(cur, user["id"], "create", "purchase_order", po_id, po_no or "")
                c.commit()
                self.redirect("/po")
                return

            if path == "/receive/add":
                if not self.require_role(user, ["admin", "warehouse"]):
                    self.respond(page("Forbidden", "<h2>Forbidden</h2>"), status=HTTPStatus.FORBIDDEN); return
                po_id = (form.get("po_id") or "").strip()
                cur.execute(
                    "INSERT INTO receipts(po_line_id,qty_received,warehouse,location,osd_status,osd_notes,received_at) VALUES (?,?,?,?,?,?,?)",
                    (int(form.get("po_line_id")), float(form.get("qty_received")), form.get("warehouse",""), form.get("location",""), form.get("osd_status","OK"), form.get("osd_notes",""), now_iso())
                )
                audit(cur, user["id"], "create", "receipt", cur.lastrowid, f"po_line={form.get('po_line_id')}")
                c.commit()
                self.redirect(f"/receive?po_id={po_id}" if po_id else "/receive")
                return

            if path == "/po_line/update":
                if not self.require_role(user, ["admin", "buyer"]):
                    self.respond(page("Forbidden", "<h2>Forbidden</h2>"), status=HTTPStatus.FORBIDDEN); return
                po_line_id = int(form.get("po_line_id"))
                expected_updated_at = form.get("updated_at", "")
                cur.execute(
                    """
                    UPDATE po_lines
                    SET size_1=?, size_2=?, thk_1=?, thk_2=?, qty_ordered=?, unit_price=?, updated_at=?
                    WHERE id=? AND updated_at=?
                    """,
                    (
                        form.get("size_1", "").strip(),
                        form.get("size_2", "").strip(),
                        form.get("thk_1", "").strip(),
                        form.get("thk_2", "").strip(),
                        float(form.get("qty_ordered", "0") or 0),
                        float(form.get("unit_price", "0") or 0),
                        now_iso(),
                        po_line_id,
                        expected_updated_at
                    )
                )
                if cur.rowcount == 0:
                    raise ValueError("This PO line was modified by another user. Refresh and try again.")
                audit(cur, user["id"], "update", "po_line", po_line_id, "")
                c.commit()
                self.redirect("/po")
                return

            if path == "/po/update":
                if not self.require_role(user, ["admin", "buyer"]):
                    self.respond(page("Forbidden", "<h2>Forbidden</h2>"), status=HTTPStatus.FORBIDDEN); return
                po_id = int(form.get("po_id"))
                expected_updated_at = form.get("updated_at", "")
                cur.execute(
                    "UPDATE purchase_orders SET po_no=?, vendor_id=?, status=?, updated_at=? WHERE id=? AND updated_at=?",
                    (
                        form.get("po_no", "").strip(),
                        int(form.get("vendor_id")),
                        form.get("status", "OPEN").strip() or "OPEN",
                        now_iso(),
                        po_id,
                        expected_updated_at
                    )
                )
                if cur.rowcount == 0:
                    raise ValueError("This PO was modified by another user. Refresh and try again.")
                audit(cur, user["id"], "update", "purchase_order", po_id, form.get("po_no",""))
                c.commit()
                self.redirect("/po")
                return

            if path == "/po/delete":
                if not self.require_role(user, ["admin", "buyer"]):
                    self.respond(page("Forbidden", "<h2>Forbidden</h2>"), status=HTTPStatus.FORBIDDEN); return
                po_id = int(form.get("po_id"))
                cur.execute("SELECT rfq_id FROM purchase_orders WHERE id=?", (po_id,))
                rec = cur.fetchone()
                rfq_id = rec[0] if rec else None
                cur.execute(
                    """
                    DELETE FROM receipts
                    WHERE po_line_id IN (SELECT id FROM po_lines WHERE po_id=?)
                    """,
                    (po_id,)
                )
                cur.execute("DELETE FROM po_lines WHERE po_id=?", (po_id,))
                cur.execute("DELETE FROM purchase_orders WHERE id=?", (po_id,))

                if rfq_id:
                    cur.execute("SELECT COUNT(*) FROM rfq_items WHERE rfq_id=?", (rfq_id,))
                    total_items = cur.fetchone()[0]
                    cur.execute(
                        """
                        SELECT COUNT(DISTINCT ri.id)
                        FROM rfq_items ri
                        JOIN purchase_orders po ON po.rfq_id = ri.rfq_id
                        JOIN po_lines pl ON pl.po_id = po.id AND pl.material_item_id = ri.material_item_id
                        WHERE ri.rfq_id=?
                        """,
                        (rfq_id,)
                    )
                    issued_items = cur.fetchone()[0]
                    new_status = "CLOSED" if total_items > 0 and issued_items >= total_items else "OPEN"
                    cur.execute("UPDATE rfqs SET status=? WHERE id=?", (new_status, rfq_id))

                audit(cur, user["id"], "delete", "purchase_order", po_id, "")
                c.commit()
                self.redirect("/po")
                return

            self.respond(page("Error", "<h2>Unknown POST route</h2>"), status=HTTPStatus.BAD_REQUEST)
        except Exception as e:
            self.respond(page("Error", f"<h2>Error</h2><pre>{e}</pre>"), status=HTTPStatus.BAD_REQUEST)
        finally:
            c.close()

    def dashboard(self):
        c = conn(); cur = c.cursor()
        stats = {}
        for t in ["rfqs", "purchase_orders", "receipts", "vendors"]:
            cur.execute(f"SELECT COUNT(*) FROM {t}")
            stats[t] = cur.fetchone()[0]
        cur.execute("SELECT COUNT(*) FROM receipts WHERE osd_status != 'OK'")
        osd = cur.fetchone()[0]
        c.close()
        body = f"""
        <h2>Material Control Dashboard</h2>
        <div class='grid'>
          <div class='card'><h3>RFQs</h3><div>{stats['rfqs']}</div></div>
          <div class='card'><h3>POs</h3><div>{stats['purchase_orders']}</div></div>
          <div class='card'><h3>Receipts</h3><div>{stats['receipts']}</div></div>
          <div class='card'><h3>OS&D Cases</h3><div>{osd}</div></div>
        </div>
        """
        return page("Dashboard", body)

    def login_page(self, error_msg=""):
        err = f"<div class='card' style='border:1px solid #b91c1c;color:#b91c1c;'>{error_msg}</div>" if error_msg else ""
        body = f"""
        <h2>Login</h2>
        {err}
        <div class='card'>
          <p class='muted'>Default admin: username <strong>admin</strong>, password <strong>admin123</strong></p>
          <form method='post' action='/login'>
            <div class='grid'>
              <div><label>Username</label><input name='username' required /></div>
              <div><label>Password</label><input name='password' type='password' required /></div>
            </div>
            <button type='submit'>Sign In</button>
          </form>
        </div>
        """
        return page("Login", body)

    def vendors_page(self):
        c = conn(); cur = c.cursor()
        cur.execute("SELECT * FROM vendors ORDER BY name")
        rows = cur.fetchall(); c.close()
        cat_checks = "".join([f"<label><input type='checkbox' name='categories' value='{c}' /> {c.title()}</label>" for c in VENDOR_CATEGORIES])
        trs = "".join([
            f"<tr><td>{r['name']}</td><td>{r['email']}</td><td>{r['phone']}</td><td>{(r['categories'] or '').replace(',', ', ')}</td><td><a class='btn btn-secondary' href='/vendors/{r['id']}/edit'>Edit</a></td></tr>"
            for r in rows
        ])
        body = f"""
        <h2>Vendors</h2>
        <div class='card'>
          <form method='post' action='/vendors/add'>
            <div class='grid'>
              <div><label>Name</label><input name='name' required /></div>
              <div><label>Email</label><input name='email' /></div>
              <div><label>Phone</label><input name='phone' /></div>
            </div>
            <label>Categories</label>
            <div class='grid'>{cat_checks}</div>
            <button type='submit'>Add Vendor</button>
          </form>
        </div>
        <div class='card'><table><tr><th>Name</th><th>Email</th><th>Phone</th><th>Categories</th><th>Actions</th></tr>{trs}</table></div>
        """
        return page("Vendors", body)

    def vendor_edit_page(self, vendor_id):
        c = conn(); cur = c.cursor()
        cur.execute("SELECT * FROM vendors WHERE id=?", (vendor_id,))
        v = cur.fetchone()
        c.close()
        if not v:
            return page("Not Found", "<h2>Vendor not found</h2>")
        selected = set((v["categories"] or "").split(","))
        cat_checks = "".join([
            f"<label><input type='checkbox' name='categories' value='{c}' {'checked' if c in selected else ''} /> {c.title()}</label>"
            for c in VENDOR_CATEGORIES
        ])
        body = f"""
        <h2>Edit Vendor</h2>
        <div class='card'>
          <form method='post' action='/vendors/update'>
            <input type='hidden' name='vendor_id' value='{v['id']}' />
            <div class='grid'>
              <div><label>Name</label><input name='name' value='{v['name']}' required /></div>
              <div><label>Email</label><input name='email' value='{v['email'] or ''}' /></div>
              <div><label>Phone</label><input name='phone' value='{v['phone'] or ''}' /></div>
            </div>
            <label>Categories</label>
            <div class='grid'>{cat_checks}</div>
            <div class='actions'>
              <button type='submit'>Save Vendor</button>
              <a class='btn btn-secondary' href='/vendors'>Back To Vendors</a>
            </div>
          </form>
        </div>
        """
        return page("Edit Vendor", body)

    def rfq_page(self):
        c = conn(); cur = c.cursor()
        cur.execute("SELECT * FROM rfqs ORDER BY id DESC")
        rows = cur.fetchall(); c.close()
        trs = "".join([f"<tr><td><a href='/rfq/{r['id']}'>{r['rfq_no']}</a></td><td>{r['project_name']}</td><td>{r['due_date'] or ''}</td><td>{r['status']}</td></tr>" for r in rows])
        body = f"""
        <h2>RFQs</h2>
        <div class='card'>
          <form method='post' action='/rfq/add'>
            <div class='grid'>
              <div><label>RFQ Number</label><input name='rfq_no' required /></div>
              <div><label>Project</label><input name='project_name' required /></div>
              <div><label>Due Date</label><input name='due_date' type='date' /></div>
            </div>
            <button type='submit'>Create RFQ</button>
          </form>
        </div>
        <div class='card'><table><tr><th>RFQ</th><th>Project</th><th>Due</th><th>Status</th></tr>{trs}</table></div>
        """
        return page("RFQ", body)

    def rfq_detail(self, rfq_id):
        c = conn(); cur = c.cursor()
        cur.execute("SELECT * FROM rfqs WHERE id=?", (rfq_id,))
        rfq = cur.fetchone()
        if not rfq:
            c.close()
            return page("Not Found", "<h2>RFQ not found</h2>")

        cur.execute(
            """
            SELECT ri.id, mi.item_code, mi.description, mi.material_type, mi.uom, ri.qty
                 , COALESCE(ri.size_1, '') AS size_1
                 , COALESCE(ri.size_2, '') AS size_2
                 , COALESCE(ri.thk_1, '') AS thk_1
                 , COALESCE(ri.thk_2, '') AS thk_2
                 , COALESCE(ri.notes, '') AS notes
            FROM rfq_items ri
            JOIN material_items mi ON mi.id = ri.material_item_id
            WHERE ri.rfq_id=?
            ORDER BY ri.id DESC
            """,
            (rfq_id,)
        )
        items = cur.fetchall()
        cur.execute("SELECT id, name FROM vendors ORDER BY name")
        vendors = cur.fetchall()
        cur.execute(
            """
            SELECT DISTINCT v.id, v.name
            FROM quotes q
            JOIN rfq_items ri ON ri.id = q.rfq_item_id
            JOIN vendors v ON v.id = q.vendor_id
            WHERE ri.rfq_id=?
            ORDER BY v.name
            """,
            (rfq_id,)
        )
        quote_vendors = cur.fetchall()
        cur.execute("SELECT COUNT(*) FROM purchase_orders WHERE rfq_id=?", (rfq_id,))
        po_count_for_rfq = cur.fetchone()[0]

        item_rows = ""
        for i in items:
            cur.execute("SELECT vendor_id, unit_price, lead_days FROM quotes WHERE rfq_item_id=?", (i["id"],))
            qrows = cur.fetchall()
            qmap = {r["vendor_id"]: f"${float(r['unit_price']):.2f} | {int(r['lead_days'])}d" for r in qrows}
            vendor_cells = "".join([f"<td>{qmap.get(v['id'], '-')}</td>" for v in quote_vendors])
            cur.execute(
                """
                SELECT DISTINCT po.po_no
                FROM purchase_orders po
                JOIN po_lines pl ON pl.po_id = po.id
                JOIN rfq_items ri ON ri.rfq_id = po.rfq_id
                WHERE ri.id=? AND pl.material_item_id = ri.material_item_id
                ORDER BY po.po_no
                """,
                (i["id"],)
            )
            po_refs = [r["po_no"] for r in cur.fetchall()]
            po_ref_txt = ", ".join(po_refs) if po_refs else "Not Issued"
            item_rows += f"""
            <tr>
              <td>{i['item_code']}</td><td>{i['description']}</td><td>{i['material_type']}</td><td>{i['qty']}</td><td>{i['uom']}</td>
              <td>{i['size_1']}</td><td>{i['size_2']}</td><td>{i['thk_1']}</td><td>{i['thk_2']}</td><td>{i['notes']}</td>
              {vendor_cells}
              <td>{po_ref_txt}</td>
              <td>
                <div class='actions'>
                  <a class='btn btn-secondary' href='/rfq_item/{i["id"]}/quotes'>Manage Quotes</a>
                  <a class='btn btn-secondary' href='/rfq_item/{i["id"]}/edit'>Edit</a>
                  <form method='post' action='/rfq_item/delete' onsubmit="return confirm('Delete this RFQ item?');">
                    <input type='hidden' name='rfq_id' value='{rfq_id}' />
                    <input type='hidden' name='rfq_item_id' value='{i['id']}' />
                    <button class='btn btn-danger' type='submit'>Delete</button>
                  </form>
                </div>
              </td>
            </tr>
            """

        vendor_opts = "".join([f"<option value='{v['id']}'>{v['name']}</option>" for v in vendors])
        c.close()

        upload_items_card = f"""
        <div class='card'>
          <h3>Upload RFQ Items</h3>
          <p class='muted'>CSV columns: item_code, description, material_type, uom, size_1, size_2, thk_1, thk_2, qty, notes</p>
          <form method='post' action='/rfq/{rfq_id}/upload' enctype='multipart/form-data'>
            <label>CSV/XLSX File</label><input type='file' name='csv_file' accept='.csv,.xlsx' />
            <label>Or Paste CSV</label><textarea name='csv_text' rows='6'></textarea>
            <button type='submit'>Import Items</button>
          </form>
        </div>
        """
        upload_top = upload_items_card if len(items) == 0 and po_count_for_rfq == 0 else ""
        upload_bottom = upload_items_card if len(items) > 0 and po_count_for_rfq == 0 else ""
        vendor_headers = "".join([f"<th>{v['name']}</th>" for v in quote_vendors])

        issue_po_card = f"""
        <h2>RFQ {rfq['rfq_no']}</h2>
        <div class='card'>
          <h3>Issue PO From This RFQ</h3>
          <form method='post' action='/po/create'>
            <input type='hidden' name='rfq_id' value='{rfq_id}' />
            <div class='grid'>
              <div><label>PO Number</label><input name='po_no' required /></div>
              <div><label>Vendor</label><select name='vendor_id'>{vendor_opts}</select></div>
            </div>
            <button type='submit'>Create PO Using Vendor Quotes</button>
          </form>
        </div>
        """
        import_quotes_card = f"""
        <div class='card'>
          <h3>Import Vendor Quotes</h3>
          <p class='muted'>CSV columns: vendor_name, item_code, unit_price, lead_days</p>
          <form method='post' action='/rfq/{rfq_id}/quotes_upload' enctype='multipart/form-data'>
            <label>Quote CSV/XLSX File</label><input type='file' name='csv_file' accept='.csv,.xlsx' />
            <label>Or Paste Quote CSV</label><textarea name='csv_text' rows='6'></textarea>
            <button type='submit'>Import Quotes</button>
          </form>
        </div>
        """
        body = f"""
        <h2>RFQ {rfq['rfq_no']}</h2>
        {upload_top}
        {'' if po_count_for_rfq > 0 else import_quotes_card}

        {'' if po_count_for_rfq > 0 else issue_po_card}

        <div class='card'>
          <h3>RFQ Items</h3>
          <table>
            <tr><th>Item</th><th>Description</th><th>Type</th><th>Qty</th><th>UOM</th><th>Size 1</th><th>Size 2</th><th>Thk 1</th><th>Thk 2</th><th>Notes</th>{vendor_headers}<th>Issued PO</th><th>Actions</th></tr>
            {item_rows}
          </table>
        </div>
        {upload_bottom}
        """
        return page(f"RFQ {rfq['rfq_no']}", body)

    def rfq_item_edit_page(self, rfq_item_id):
        c = conn(); cur = c.cursor()
        cur.execute(
            """
            SELECT ri.id, ri.rfq_id, ri.qty, COALESCE(ri.size_1, '') AS size_1, COALESCE(ri.size_2, '') AS size_2,
                   COALESCE(ri.thk_1, '') AS thk_1, COALESCE(ri.thk_2, '') AS thk_2, COALESCE(ri.notes, '') AS notes,
                   ri.updated_at,
                   mi.item_code, mi.description, mi.material_type, mi.uom
            FROM rfq_items ri
            JOIN material_items mi ON mi.id = ri.material_item_id
            WHERE ri.id=?
            """,
            (rfq_item_id,)
        )
        i = cur.fetchone()
        c.close()
        if not i:
            return page("Not Found", "<h2>RFQ item not found</h2>")

        body = f"""
        <h2>Edit RFQ Item</h2>
        <div class='card'>
          <form method='post' action='/rfq_item/update'>
            <input type='hidden' name='rfq_id' value='{i['rfq_id']}' />
            <input type='hidden' name='rfq_item_id' value='{i['id']}' />
            <input type='hidden' name='updated_at' value='{i['updated_at']}' />
            <div class='grid'>
              <div><label>Item Code</label><input name='item_code' value='{i['item_code']}' required /></div>
              <div><label>Description</label><input name='description' value='{i['description']}' /></div>
              <div><label>Type</label><input name='material_type' value='{i['material_type']}' /></div>
              <div><label>UOM</label><input name='uom' value='{i['uom']}' /></div>
              <div><label>Qty</label><input name='qty' type='number' step='0.01' value='{i['qty']}' required /></div>
              <div><label>Size 1</label><input name='size_1' value='{i['size_1']}' /></div>
              <div><label>Size 2</label><input name='size_2' value='{i['size_2']}' /></div>
              <div><label>Thk 1</label><input name='thk_1' value='{i['thk_1']}' /></div>
              <div><label>Thk 2</label><input name='thk_2' value='{i['thk_2']}' /></div>
            </div>
            <label>Notes</label><textarea name='notes' rows='3'>{i['notes']}</textarea>
            <div class='actions'>
              <button type='submit'>Save Item</button>
              <a class='btn btn-secondary' href='/rfq/{i["rfq_id"]}'>Back To RFQ</a>
            </div>
          </form>
        </div>
        """
        return page("Edit RFQ Item", body)

    def rfq_item_quotes_page(self, rfq_item_id):
        c = conn(); cur = c.cursor()
        cur.execute(
            """
            SELECT ri.id, ri.rfq_id, mi.item_code, mi.description
            FROM rfq_items ri
            JOIN material_items mi ON mi.id = ri.material_item_id
            WHERE ri.id=?
            """,
            (rfq_item_id,)
        )
        item = cur.fetchone()
        if not item:
            c.close()
            return page("Not Found", "<h2>RFQ item not found</h2>")

        cur.execute("SELECT id, name FROM vendors ORDER BY name")
        vendors = cur.fetchall()
        vendor_opts = "".join([f"<option value='{v['id']}'>{v['name']}</option>" for v in vendors])

        cur.execute(
            """
            SELECT v.name AS vendor_name, q.unit_price, q.lead_days, q.quoted_at
            FROM quotes q
            JOIN vendors v ON v.id=q.vendor_id
            WHERE q.rfq_item_id=?
            ORDER BY q.unit_price, q.lead_days
            """,
            (rfq_item_id,)
        )
        quotes = cur.fetchall()
        c.close()

        quote_rows = "".join([
            f"<tr><td>{q['vendor_name']}</td><td>${q['unit_price']:.2f}</td><td>{q['lead_days']} days</td><td>{q['quoted_at']}</td></tr>"
            for q in quotes
        ])
        if not quote_rows:
            quote_rows = "<tr><td colspan='4' class='muted'>No quotes yet</td></tr>"

        body = f"""
        <h2>Manage Quotes</h2>
        <div class='card'>
          <div><strong>Item:</strong> {item['item_code']} - {item['description']}</div>
          <div class='muted'>RFQ Line ID: {item['id']}</div>
        </div>
        <div class='card'>
          <h3>Add/Update Vendor Quote</h3>
          <form method='post' action='/quote/add'>
            <input type='hidden' name='rfq_id' value='{item['rfq_id']}' />
            <input type='hidden' name='rfq_item_id' value='{item['id']}' />
            <div class='grid'>
              <div><label>Vendor</label><select name='vendor_id'>{vendor_opts}</select></div>
              <div><label>Unit Price</label><input name='unit_price' type='number' step='0.01' required /></div>
              <div><label>Lead Days</label><input name='lead_days' type='number' /></div>
            </div>
            <div class='actions'>
              <button type='submit'>Save Quote</button>
              <a class='btn btn-secondary' href='/rfq/{item["rfq_id"]}'>Back To RFQ</a>
            </div>
          </form>
        </div>
        <div class='card'>
          <h3>Current Quotes</h3>
          <table>
            <tr><th>Vendor</th><th>Unit Price</th><th>Lead Time</th><th>Updated</th></tr>
            {quote_rows}
          </table>
        </div>
        """
        return page("Manage Quotes", body)

    def po_page(self):
        c = conn(); cur = c.cursor()
        q = parse_qs(urlparse(self.path).query)
        po_no_q = (q.get("po_no", [""])[0] or "").strip()
        rfq_no_q = (q.get("rfq_no", [""])[0] or "").strip()
        vendor_id_q = (q.get("vendor_id", [""])[0] or "").strip()
        status_q = (q.get("status", [""])[0] or "").strip()

        where = []
        params = []
        if po_no_q:
            where.append("po.po_no LIKE ?")
            params.append(f"%{po_no_q}%")
        if rfq_no_q:
            where.append("r.rfq_no LIKE ?")
            params.append(f"%{rfq_no_q}%")
        if vendor_id_q:
            where.append("po.vendor_id = ?")
            params.append(int(vendor_id_q))
        if status_q:
            where.append("po.status = ?")
            params.append(status_q)
        where_sql = ("WHERE " + " AND ".join(where)) if where else ""

        cur.execute(
            f"""
            SELECT po.id, po.po_no, po.status, po.created_at, v.name AS vendor,
                   COALESCE(r.rfq_no, '') AS rfq_no
            FROM purchase_orders po
            JOIN vendors v ON v.id=po.vendor_id
            LEFT JOIN rfqs r ON r.id=po.rfq_id
            {where_sql}
            ORDER BY po.id DESC
            LIMIT 300
            """,
            tuple(params)
        )
        pos = cur.fetchall()
        cur.execute("SELECT id, name FROM vendors ORDER BY name")
        all_vendors = cur.fetchall()
        blocks = ""
        for p in pos:
            cur.execute(
                """
                SELECT pl.id, mi.item_code, mi.description, pl.qty_ordered, pl.unit_price,
                       COALESCE(pl.size_1, '') AS size_1,
                       COALESCE(pl.size_2, '') AS size_2,
                       COALESCE(pl.thk_1, '') AS thk_1,
                       COALESCE(pl.thk_2, '') AS thk_2,
                       COALESCE((SELECT SUM(r.qty_received) FROM receipts r WHERE r.po_line_id=pl.id),0) AS qty_received
                FROM po_lines pl
                JOIN material_items mi ON mi.id=pl.material_item_id
                WHERE pl.po_id=?
                """,
                (p["id"],)
            )
            lines = cur.fetchall()
            trs = "".join([f"<tr><td>{l['item_code']}</td><td>{l['description']}</td><td>{l['size_1']}</td><td>{l['size_2']}</td><td>{l['thk_1']}</td><td>{l['thk_2']}</td><td>{l['qty_ordered']}</td><td>${l['unit_price']:.2f}</td><td>{l['qty_received']}</td><td><a class='btn btn-secondary' href='/po_line/{l['id']}/edit'>Edit</a></td></tr>" for l in lines])
            blocks += f"""
            <div class='card'>
              <h3>{p['po_no']} - {p['vendor']}</h3>
              <div class='muted'>RFQ: {p['rfq_no'] or 'N/A'} | Status: {p['status']} | Created: {p['created_at']}</div>
              <div class='actions' style='margin:8px 0 12px 0;'>
                <a class='btn btn-secondary' href='/po/{p["id"]}/edit'>Edit PO</a>
                <form method='post' action='/po/delete' onsubmit="return confirm('Delete this PO and all related receiving records?');">
                  <input type='hidden' name='po_id' value='{p['id']}' />
                  <button class='btn btn-danger' type='submit'>Delete PO</button>
                </form>
              </div>
              <table><tr><th>Item</th><th>Description</th><th>Size 1</th><th>Size 2</th><th>Thk 1</th><th>Thk 2</th><th>Qty Ordered</th><th>Unit Price</th><th>Qty Received</th><th>Action</th></tr>{trs}</table>
            </div>
            """
        vendor_opts = "<option value=''>All Vendors</option>" + "".join([
            f"<option value='{v['id']}' {'selected' if str(v['id']) == vendor_id_q else ''}>{v['name']}</option>"
            for v in all_vendors
        ])
        filter_card = f"""
        <div class='card'>
          <form method='get' action='/po'>
            <div class='grid'>
              <div><label>PO #</label><input name='po_no' value='{po_no_q}' /></div>
              <div><label>RFQ #</label><input name='rfq_no' value='{rfq_no_q}' /></div>
              <div><label>Vendor</label><select name='vendor_id'>{vendor_opts}</select></div>
              <div><label>Status</label><select name='status'>
                <option value='' {'selected' if status_q=='' else ''}>All Statuses</option>
                <option value='OPEN' {'selected' if status_q=='OPEN' else ''}>OPEN</option>
                <option value='CLOSED' {'selected' if status_q=='CLOSED' else ''}>CLOSED</option>
              </select></div>
            </div>
            <div class='actions'>
              <button type='submit'>Filter POs</button>
              <a class='btn btn-secondary' href='/po'>Clear</a>
              <span class='muted'>{len(pos)} result(s), max 300 shown</span>
            </div>
          </form>
        </div>
        """
        c.close()
        return page("POs", f"<h2>Purchase Orders</h2>{filter_card}{blocks or '<div class=card>No POs match filter</div>'}")

    def po_edit_page(self, po_id):
        c = conn(); cur = c.cursor()
        cur.execute(
            """
            SELECT po.id, po.po_no, po.vendor_id, po.status, po.created_at, COALESCE(r.rfq_no, '') AS rfq_no
                 , po.updated_at
            FROM purchase_orders po
            LEFT JOIN rfqs r ON r.id=po.rfq_id
            WHERE po.id=?
            """,
            (po_id,)
        )
        po = cur.fetchone()
        if not po:
            c.close()
            return page("Not Found", "<h2>PO not found</h2>")
        cur.execute("SELECT id, name FROM vendors ORDER BY name")
        vendors = cur.fetchall()
        c.close()
        vendor_opts = "".join([f"<option value='{v['id']}' {'selected' if v['id'] == po['vendor_id'] else ''}>{v['name']}</option>" for v in vendors])
        body = f"""
        <h2>Edit PO</h2>
        <div class='card'>
          <div class='muted'>RFQ: {po['rfq_no'] or 'N/A'} | Created: {po['created_at']}</div>
          <form method='post' action='/po/update'>
            <input type='hidden' name='po_id' value='{po['id']}' />
            <input type='hidden' name='updated_at' value='{po['updated_at']}' />
            <div class='grid'>
              <div><label>PO Number</label><input name='po_no' value='{po['po_no']}' required /></div>
              <div><label>Vendor</label><select name='vendor_id'>{vendor_opts}</select></div>
              <div><label>Status</label><select name='status'>
                <option {'selected' if po['status']=='OPEN' else ''}>OPEN</option>
                <option {'selected' if po['status']=='CLOSED' else ''}>CLOSED</option>
              </select></div>
            </div>
            <div class='actions'>
              <button type='submit'>Save PO</button>
              <a class='btn btn-secondary' href='/po'>Back To POs</a>
            </div>
          </form>
        </div>
        """
        return page("Edit PO", body)

    def po_line_edit_page(self, po_line_id):
        c = conn(); cur = c.cursor()
        cur.execute(
            """
            SELECT pl.id, pl.qty_ordered, pl.unit_price,
                   COALESCE(pl.size_1, '') AS size_1,
                   COALESCE(pl.size_2, '') AS size_2,
                   COALESCE(pl.thk_1, '') AS thk_1,
                   COALESCE(pl.thk_2, '') AS thk_2,
                   pl.updated_at,
                   mi.item_code, mi.description, po.po_no
            FROM po_lines pl
            JOIN material_items mi ON mi.id = pl.material_item_id
            JOIN purchase_orders po ON po.id = pl.po_id
            WHERE pl.id=?
            """,
            (po_line_id,)
        )
        line = cur.fetchone()
        c.close()
        if not line:
            return page("Not Found", "<h2>PO line not found</h2>")

        body = f"""
        <h2>Edit PO Line</h2>
        <div class='card'>
          <div><strong>PO:</strong> {line['po_no']}</div>
          <div><strong>Item:</strong> {line['item_code']} - {line['description']}</div>
        </div>
        <div class='card'>
          <form method='post' action='/po_line/update'>
            <input type='hidden' name='po_line_id' value='{line['id']}' />
            <input type='hidden' name='updated_at' value='{line['updated_at']}' />
            <div class='grid'>
              <div><label>Qty Ordered</label><input type='number' step='0.01' name='qty_ordered' value='{line['qty_ordered']}' required /></div>
              <div><label>Unit Price</label><input type='number' step='0.01' name='unit_price' value='{line['unit_price']}' required /></div>
              <div><label>Size 1</label><input name='size_1' value='{line['size_1']}' /></div>
              <div><label>Size 2</label><input name='size_2' value='{line['size_2']}' /></div>
              <div><label>Thk 1</label><input name='thk_1' value='{line['thk_1']}' /></div>
              <div><label>Thk 2</label><input name='thk_2' value='{line['thk_2']}' /></div>
            </div>
            <div class='actions'>
              <button type='submit'>Save PO Line</button>
              <a class='btn btn-secondary' href='/po'>Back To POs</a>
            </div>
          </form>
        </div>
        """
        return page("Edit PO Line", body)

    def receive_page(self):
        c = conn(); cur = c.cursor()
        q = parse_qs(urlparse(self.path).query)
        po_filter = (q.get("po_id", [""])[0] or "").strip()

        cur.execute("SELECT id, po_no FROM purchase_orders ORDER BY id DESC")
        po_rows = cur.fetchall()
        po_opts = "<option value=''>All POs</option>" + "".join([
            f"<option value='{p['id']}' {'selected' if str(p['id']) == po_filter else ''}>{p['po_no']}</option>"
            for p in po_rows
        ])

        where_sql = ""
        params = []
        if po_filter:
            where_sql = "WHERE po.id=?"
            params.append(int(po_filter))

        cur.execute(
            f"""
            SELECT pl.id, po.po_no, mi.item_code, mi.description, pl.qty_ordered,
                   COALESCE(pl.size_1, '') AS size_1,
                   COALESCE(pl.size_2, '') AS size_2,
                   COALESCE(pl.thk_1, '') AS thk_1,
                   COALESCE(pl.thk_2, '') AS thk_2,
                   COALESCE((SELECT SUM(r.qty_received) FROM receipts r WHERE r.po_line_id=pl.id),0) AS qty_received
            FROM po_lines pl
            JOIN purchase_orders po ON po.id=pl.po_id
            JOIN material_items mi ON mi.id=pl.material_item_id
            {"WHERE po.id=? AND " if po_filter else "WHERE "}
            COALESCE((SELECT SUM(r.qty_received) FROM receipts r WHERE r.po_line_id=pl.id),0) < pl.qty_ordered
            ORDER BY po.id DESC
            """,
            tuple(params)
        )
        lines = cur.fetchall()
        opts = "".join([f"<option value='{l['id']}'>{l['po_no']} | {l['item_code']} | {l['size_1']}/{l['size_2']} | {l['thk_1']}/{l['thk_2']} | Ordered {l['qty_ordered']} | Rec {l['qty_received']}</option>" for l in lines])

        cur.execute(
            f"""
            SELECT r.received_at, po.po_no, mi.item_code, r.qty_received, r.warehouse, r.location, r.osd_status, r.osd_notes
                 , COALESCE(pl.size_1, '') AS size_1
                 , COALESCE(pl.size_2, '') AS size_2
                 , COALESCE(pl.thk_1, '') AS thk_1
                 , COALESCE(pl.thk_2, '') AS thk_2
            FROM receipts r
            JOIN po_lines pl ON pl.id=r.po_line_id
            JOIN purchase_orders po ON po.id=pl.po_id
            JOIN material_items mi ON mi.id=pl.material_item_id
            {where_sql}
            ORDER BY r.id DESC LIMIT 30
            """,
            tuple(params)
        )
        recs = cur.fetchall(); c.close()
        rows = "".join([f"<tr><td>{x['received_at']}</td><td>{x['po_no']}</td><td>{x['item_code']}</td><td>{x['size_1']}</td><td>{x['size_2']}</td><td>{x['thk_1']}</td><td>{x['thk_2']}</td><td>{x['qty_received']}</td><td>{x['warehouse']}</td><td>{x['location']}</td><td>{x['osd_status']}</td><td>{x['osd_notes'] or ''}</td></tr>" for x in recs])
        body = f"""
        <h2>Receiving</h2>
        <div class='card'>
          <form method='get' action='/receive'>
            <div class='grid'>
              <div><label>Filter By PO</label><select name='po_id'>{po_opts}</select></div>
            </div>
            <div class='actions'>
              <button type='submit'>Apply Filter</button>
              <a class='btn btn-secondary' href='/receive'>Clear</a>
            </div>
          </form>
        </div>
        <div class='card'>
          <form method='post' action='/receive/add'>
            <input type='hidden' name='po_id' value='{po_filter}' />
            <label>PO Line</label><select name='po_line_id'>{opts}</select>
            <div class='grid'>
              <div><label>Qty Received</label><input type='number' step='0.01' name='qty_received' required /></div>
              <div><label>Warehouse</label><input name='warehouse' required /></div>
              <div><label>Location</label><input name='location' required /></div>
              <div><label>OS&D Status</label>
                <select name='osd_status'>
                  <option>OK</option><option>OVERAGE</option><option>SHORTAGE</option><option>DAMAGE</option>
                </select>
              </div>
            </div>
            <label>OS&D Notes</label><textarea name='osd_notes' rows='3'></textarea>
            <button type='submit'>Receive Material</button>
          </form>
        </div>
        <div class='card'><table><tr><th>Received</th><th>PO</th><th>Item</th><th>Size 1</th><th>Size 2</th><th>Thk 1</th><th>Thk 2</th><th>Qty</th><th>Warehouse</th><th>Location</th><th>OS&D</th><th>Notes</th></tr>{rows}</table></div>
        """
        return page("Receiving", body)

    def inventory_page(self):
        c = conn(); cur = c.cursor()
        cur.execute(
            """
            SELECT mi.item_code, mi.description, r.warehouse, r.location,
                   COALESCE(pl.size_1, '') AS size_1,
                   COALESCE(pl.size_2, '') AS size_2,
                   COALESCE(pl.thk_1, '') AS thk_1,
                   COALESCE(pl.thk_2, '') AS thk_2,
                   SUM(r.qty_received) AS qty_on_hand,
                   SUM(CASE WHEN r.osd_status='OK' THEN 0 ELSE r.qty_received END) AS qty_osd
            FROM receipts r
            JOIN po_lines pl ON pl.id=r.po_line_id
            JOIN material_items mi ON mi.id=pl.material_item_id
            GROUP BY mi.item_code, mi.description, r.warehouse, r.location, pl.size_1, pl.size_2, pl.thk_1, pl.thk_2
            ORDER BY mi.item_code
            """
        )
        rows = cur.fetchall(); c.close()
        trs = "".join([f"<tr><td>{r['item_code']}</td><td>{r['description']}</td><td>{r['size_1']}</td><td>{r['size_2']}</td><td>{r['thk_1']}</td><td>{r['thk_2']}</td><td>{r['warehouse']}</td><td>{r['location']}</td><td>{r['qty_on_hand']}</td><td>{r['qty_osd']}</td></tr>" for r in rows])
        return page("Inventory", f"<h2>Inventory by Location</h2><div class='card'><table><tr><th>Item</th><th>Description</th><th>Size 1</th><th>Size 2</th><th>Thk 1</th><th>Thk 2</th><th>Warehouse</th><th>Location</th><th>Qty On Hand</th><th>Qty with OS&D</th></tr>{trs}</table></div>")


if __name__ == "__main__":
    init_db()
    server = HTTPServer(("127.0.0.1", 8000), App)
    print("Running on http://127.0.0.1:8000")
    server.serve_forever()




