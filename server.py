"""Local Ak's Dairy web app with a SQLite customer and order database."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import hashlib
import json
import secrets
import sqlite3
import os
from datetime import datetime, timezone, timedelta
import socket
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "aks_dairy.sqlite3"
PORT = 8000
DATABASE_URL = os.environ.get("DATABASE_URL") or os.environ.get("POSTGRES_URL") or os.environ.get("POSTGRES_PRISMA_URL")
ADMIN_MOBILE = "".join(ch for ch in os.environ.get("ADMIN_MOBILE", "7382756905") if ch.isdigit())
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "" if os.environ.get("VERCEL") else "123456")


class Database:
    """Small adapter so the same queries work with local SQLite and hosted Postgres."""
    def __init__(self):
        if DATABASE_URL:
            import psycopg
            from psycopg.rows import dict_row
            self.connection = psycopg.connect(DATABASE_URL, row_factory=dict_row)
            self.is_sqlite = False
        else:
            if os.environ.get("VERCEL"):
                raise RuntimeError("Connect a hosted Postgres database by setting POSTGRES_URL or DATABASE_URL in Vercel.")
            self.connection = sqlite3.connect(DB_PATH)
            self.connection.row_factory = sqlite3.Row
            self.connection.execute("PRAGMA foreign_keys = ON")
            self.is_sqlite = True

    def execute(self, statement, values=()):
        if self.is_sqlite:
            statement = statement.replace("%s", "?")
        return self.connection.execute(statement, values)

    def __enter__(self):
        self.connection.__enter__()
        return self

    def __exit__(self, exc_type, exc, tb):
        try:
            return self.connection.__exit__(exc_type, exc, tb)
        finally:
            self.connection.close()


def connect():
    return Database()


def init_db():
    with connect() as db:
        statements = [
            """CREATE TABLE IF NOT EXISTS customers (
                mobile TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                phone TEXT NOT NULL,
                password_salt TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL
            )""",
            """CREATE TABLE IF NOT EXISTS orders (
                id TEXT PRIMARY KEY,
                mobile TEXT NOT NULL REFERENCES customers(mobile),
                created_at TEXT NOT NULL,
                address TEXT NOT NULL,
                payment_method TEXT NOT NULL,
                items_json TEXT NOT NULL,
                total REAL NOT NULL
            )""",
            """CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                mobile TEXT NOT NULL REFERENCES customers(mobile)
            )""",
            """CREATE TABLE IF NOT EXISTS admin_sessions (
                token TEXT PRIMARY KEY,
                created_at TEXT NOT NULL
            )""",
            """CREATE TABLE IF NOT EXISTS deleted_customers (
                mobile TEXT PRIMARY KEY,
                deleted_at TEXT NOT NULL
            )""",
            """CREATE TABLE IF NOT EXISTS products (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                description TEXT NOT NULL,
                price REAL NOT NULL,
                unit TEXT NOT NULL,
                quantity INTEGER NOT NULL DEFAULT 0,
                category TEXT NOT NULL DEFAULT 'other',
                active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                image_data TEXT NOT NULL DEFAULT ''
            )""",
            """CREATE TABLE IF NOT EXISTS store_settings (
                setting_key TEXT PRIMARY KEY,
                setting_value TEXT NOT NULL
            )""",
        ]
        for statement in statements:
            db.execute(statement)
        db.execute("INSERT INTO store_settings(setting_key,setting_value) VALUES('is_open','1') ON CONFLICT DO NOTHING")
        if db.is_sqlite:
            columns = {row["name"] for row in db.execute("PRAGMA table_info(orders)").fetchall()}
            if "status" not in columns:
                db.execute("ALTER TABLE orders ADD COLUMN status TEXT NOT NULL DEFAULT 'placed'")
        else:
            db.execute("ALTER TABLE orders ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'placed'")
        if db.is_sqlite:
            product_columns = {row["name"] for row in db.execute("PRAGMA table_info(products)").fetchall()}
            if "image_data" not in product_columns:
                db.execute("ALTER TABLE products ADD COLUMN image_data TEXT NOT NULL DEFAULT ''")
        else:
            db.execute("ALTER TABLE products ADD COLUMN IF NOT EXISTS image_data TEXT NOT NULL DEFAULT ''")
        if not db.execute("SELECT 1 FROM products LIMIT 1").fetchone():
            now = datetime.now(timezone.utc).isoformat()
            starter_products = [
                ("milk", "Farm Fresh Milk", "Rich, creamy & full of goodness", 68, "1 L", 50, "milk", 1, now),
                ("curd", "Homestyle Curd", "Thick, cool & wonderfully gentle", 55, "500 g", 40, "curd", 1, now),
                ("ghee", "Golden Desi Ghee", "Slow-cooked & deeply aromatic", 420, "500 ml", 20, "ghee", 1, now),
            ]
            for product in starter_products:
                db.execute("INSERT INTO products(id,name,description,price,unit,quantity,category,active,created_at) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING", product)


def mobile_digits(value):
    return "".join(ch for ch in str(value) if ch.isdigit())


def password_hash(password, salt):
    return hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 120000).hex()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        return json.loads(self.rfile.read(length) or b"{}")

    def session_mobile(self, db):
        token = self.headers.get("Authorization", "").removeprefix("Bearer ")
        row = db.execute("SELECT mobile FROM sessions WHERE token=%s", (token,)).fetchone() if token else None
        return row["mobile"] if row else None

    def is_admin(self, db):
        token = self.headers.get("Authorization", "").removeprefix("Bearer ")
        return bool(token and db.execute("SELECT 1 FROM admin_sessions WHERE token=%s", (token,)).fetchone())

    def store_is_open(self, db):
        row = db.execute("SELECT setting_value FROM store_settings WHERE setting_key='is_open'").fetchone()
        return bool(row and row["setting_value"] == "1")

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/products":
            with connect() as db:
                store_open = self.store_is_open(db)
                if parse_qs(parsed.query).get("status") == ["1"]:
                    return self.send_json({"storeOpen": store_open})
                if parse_qs(parsed.query).get("manage") == ["1"]:
                    if not self.is_admin(db):
                        return self.send_json({"error": "Admin sign-in is required."}, 401)
                    rows = db.execute("SELECT * FROM products ORDER BY active DESC, name").fetchall()
                else:
                    rows = db.execute("SELECT * FROM products WHERE active=1 ORDER BY created_at, name").fetchall()
            return self.send_json({"products": [dict(row) for row in rows], "storeOpen": store_open})
        if parsed.path == "/api/orders":
            mobile = mobile_digits(parse_qs(parsed.query).get("mobile", [""])[0])
            with connect() as db:
                if self.session_mobile(db) != mobile:
                    return self.send_json({"error": "Please sign in to view your orders."}, 401)
                rows = db.execute("SELECT o.*, c.name, c.phone FROM orders o JOIN customers c USING(mobile) WHERE o.mobile=%s ORDER BY o.created_at", (mobile,)).fetchall()
            orders = [{"id": r["id"], "createdAt": r["created_at"],
                       "customer": {"name": r["name"], "phone": r["phone"], "address": r["address"]},
                       "paymentMethod": r["payment_method"], "items": json.loads(r["items_json"]), "total": r["total"], "status": r["status"]}
                      for r in rows]
            return self.send_json({"orders": orders})
        if parsed.path == "/api/admin/orders":
            params = parse_qs(parsed.query)
            selected_date = params.get("date", [datetime.now(timezone.utc).date().isoformat()])[0]
            search = params.get("search", [""])[0].strip().upper()
            with connect() as db:
                if not self.is_admin(db):
                    return self.send_json({"error": "Admin sign-in is required."}, 401)
                live_row = db.execute("SELECT COUNT(*) AS count FROM orders WHERE status IN ('placed','approved','packed')").fetchone()
                store_open = self.store_is_open(db)
                all_rows = db.execute("SELECT o.*, c.name, c.phone FROM orders o JOIN customers c USING(mobile) ORDER BY o.created_at DESC").fetchall()
            india_offset = timezone(timedelta(hours=5, minutes=30))
            selected_rows = []
            for row in all_rows:
                try:
                    created = datetime.fromisoformat(row["created_at"].replace("Z", "+00:00"))
                    if created.tzinfo is None:
                        created = created.replace(tzinfo=timezone.utc)
                    if created.astimezone(india_offset).date().isoformat() == selected_date:
                        selected_rows.append(row)
                except ValueError:
                    continue
            summary = {"count": len(selected_rows), "earnings": sum(float(r["total"]) for r in selected_rows if r["status"] != "disapproved"), "liveCount": live_row["count"]}
            matching_rows = [r for r in all_rows if search in r["id"].upper()] if search else selected_rows
            result = [{"id": r["id"], "createdAt": r["created_at"],
                       "customer": {"name": r["name"], "phone": r["phone"], "address": r["address"]},
                       "paymentMethod": r["payment_method"], "items": json.loads(r["items_json"]),
                       "total": r["total"], "status": r["status"]} for r in matching_rows]
            return self.send_json({"orders": result, "summary": summary, "date": selected_date, "storeOpen": store_open})
        return super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            data = self.read_json()
            mobile = mobile_digits(data.get("mobile", ""))
            with connect() as db:
                if path == "/api/migrate":
                    for account in data.get("accounts", []):
                        mobile = mobile_digits(account.get("mobile", ""))
                        deleted = db.execute("SELECT 1 FROM deleted_customers WHERE mobile=%s", (mobile,)).fetchone() if mobile else None
                        if mobile and not deleted and account.get("salt") and account.get("passwordHash"):
                            db.execute("INSERT INTO customers(mobile,name,phone,password_salt,password_hash,created_at) VALUES(%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                                       (mobile, account.get("name", "Customer"), account.get("phone", mobile), account["salt"], account["passwordHash"], datetime.now(timezone.utc).isoformat()))
                    for order in data.get("orders", []):
                        mobile = mobile_digits(order.get("customer", {}).get("phone", ""))
                        deleted = db.execute("SELECT 1 FROM deleted_customers WHERE mobile=%s", (mobile,)).fetchone() if mobile else None
                        if not deleted and db.execute("SELECT 1 FROM customers WHERE mobile=%s", (mobile,)).fetchone():
                            db.execute("INSERT INTO orders(id,mobile,created_at,address,payment_method,items_json,total) VALUES(%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                                       (order["id"], mobile, order.get("createdAt", ""), order.get("customer", {}).get("address", ""),
                                        order.get("paymentMethod", "UPI"), json.dumps(order.get("items", [])), order.get("total", 0)))
                    return self.send_json({"message": "Imported"})
                if path == "/api/signup":
                    if len(mobile) < 8 or len(mobile) > 15 or len(data.get("password", "")) < 8 or not data.get("name", "").strip():
                        return self.send_json({"error": "Enter a valid name, mobile number, and password of at least 8 characters."}, 400)
                    if db.execute("SELECT 1 FROM customers WHERE mobile=%s", (mobile,)).fetchone():
                        return self.send_json({"error": "An account with that mobile number already exists. Please sign in."}, 409)
                    db.execute("DELETE FROM deleted_customers WHERE mobile=%s", (mobile,))
                    salt = secrets.token_hex(16)
                    phone = str(data.get("phone", "")).strip() or mobile
                    db.execute("INSERT INTO customers(mobile,name,phone,password_salt,password_hash,created_at) VALUES(%s,%s,%s,%s,%s,%s)",
                               (mobile, data["name"].strip(), phone, salt, password_hash(data["password"], salt), datetime.now(timezone.utc).isoformat()))
                    token = secrets.token_urlsafe(32)
                    db.execute("INSERT INTO sessions(token,mobile) VALUES(%s,%s)", (token, mobile))
                    return self.send_json({"name": data["name"].strip(), "phone": phone, "token": token})
                if path == "/api/login":
                    account = db.execute("SELECT * FROM customers WHERE mobile=%s", (mobile,)).fetchone()
                    if not account:
                        return self.send_json({"error": "We couldn’t find an account with that mobile number. Create a new customer account to get started."}, 404)
                    if password_hash(data.get("password", ""), account["password_salt"]) != account["password_hash"]:
                        return self.send_json({"error": "Wrong password. Please try again."}, 401)
                    token = secrets.token_urlsafe(32)
                    db.execute("INSERT INTO sessions(token,mobile) VALUES(%s,%s)", (token, mobile))
                    return self.send_json({"name": account["name"], "phone": account["phone"], "token": token})
                if path == "/api/reset-password":
                    account = db.execute("SELECT 1 FROM customers WHERE mobile=%s", (mobile,)).fetchone()
                    if not account:
                        return self.send_json({"error": "No account is registered with that mobile number."}, 404)
                    if data.get("otp") != "123456":
                        return self.send_json({"error": "That OTP is incorrect. Please enter 123456."}, 400)
                    if len(data.get("password", "")) < 8:
                        return self.send_json({"error": "Use a password with at least 8 characters."}, 400)
                    salt = secrets.token_hex(16)
                    db.execute("UPDATE customers SET password_salt=%s, password_hash=%s WHERE mobile=%s",
                               (salt, password_hash(data["password"], salt), mobile))
                    db.execute("DELETE FROM sessions WHERE mobile=%s", (mobile,))
                    return self.send_json({"message": "Password updated. Please sign in with your new credentials."})
                if path == "/api/recovery-start":
                    if not db.execute("SELECT 1 FROM customers WHERE mobile=%s", (mobile,)).fetchone():
                        return self.send_json({"error": "No account is registered with that mobile number."}, 404)
                    return self.send_json({"message": "Demo OTP: 123456"})
                if path == "/api/orders":
                    if self.session_mobile(db) != mobile:
                        return self.send_json({"error": "Please sign in before placing an order."}, 401)
                    if not self.store_is_open(db):
                        return self.send_json({"error": "Shop is closed. Please try again after some time."}, 403)
                    order = data.get("order", {})
                    checked_items = []
                    for item in order.get("items", []):
                        product_id = item.get("id")
                        product = db.execute("SELECT * FROM products WHERE id=%s AND active=1", (product_id,)).fetchone() if product_id else db.execute("SELECT * FROM products WHERE name=%s AND active=1", (item.get("name", ""),)).fetchone()
                        quantity = int(item.get("quantity", 0))
                        if not product:
                            return self.send_json({"error": f"{item.get('name', 'A product')} is no longer available. Please refresh your basket."}, 409)
                        if quantity < 1 or product["quantity"] < quantity:
                            return self.send_json({"error": f"Only {product['quantity']} {product['unit']} of {product['name']} remain. Please update your basket."}, 409)
                        checked_items.append({"id": product["id"], "name": product["name"], "price": product["price"], "quantity": quantity})
                    order["items"] = checked_items
                    order["total"] = sum(item["price"] * item["quantity"] for item in checked_items)
                    for item in checked_items:
                        db.execute("UPDATE products SET quantity=quantity-%s WHERE id=%s", (item["quantity"], item["id"]))
                    db.execute("INSERT INTO orders(id,mobile,created_at,address,payment_method,items_json,total,status) VALUES(%s,%s,%s,%s,%s,%s,%s,'placed')",
                               (order["id"], mobile, order["createdAt"], order["customer"]["address"],
                                order["paymentMethod"], json.dumps(order["items"]), order["total"]))
                    order["status"] = "placed"
                    return self.send_json({"order": order}, 201)
                if path == "/api/logout":
                    token = self.headers.get("Authorization", "").removeprefix("Bearer ")
                    db.execute("DELETE FROM sessions WHERE token=%s", (token,))
                    return self.send_json({"message": "Signed out"})
                if path == "/api/admin-login":
                    if not ADMIN_PASSWORD:
                        return self.send_json({"error": "Set ADMIN_PASSWORD in Vercel project environment variables before using the admin page."}, 503)
                    if mobile != ADMIN_MOBILE or not secrets.compare_digest(str(data.get("password", "")), ADMIN_PASSWORD):
                        return self.send_json({"error": "That admin mobile number and password don’t match."}, 401)
                    token = secrets.token_urlsafe(40)
                    db.execute("INSERT INTO admin_sessions(token,created_at) VALUES(%s,%s)", (token, datetime.now(timezone.utc).isoformat()))
                    return self.send_json({"token": token})
                if path == "/api/admin/logout":
                    token = self.headers.get("Authorization", "").removeprefix("Bearer ")
                    db.execute("DELETE FROM admin_sessions WHERE token=%s", (token,))
                    return self.send_json({"message": "Signed out"})
                if path == "/api/admin/order-status":
                    if not self.is_admin(db):
                        return self.send_json({"error": "Admin sign-in is required."}, 401)
                    order_id = str(data.get("orderId", ""))
                    next_status = data.get("status")
                    allowed = {"placed": {"approved", "disapproved"}, "approved": {"packed"}, "packed": {"delivered"}}
                    current = db.execute("SELECT status FROM orders WHERE id=%s", (order_id,)).fetchone()
                    if not current:
                        return self.send_json({"error": "We couldn’t find that order."}, 404)
                    if next_status not in allowed.get(current["status"], set()):
                        return self.send_json({"error": "That order can’t move to the selected status."}, 409)
                    db.execute("UPDATE orders SET status=%s WHERE id=%s", (next_status, order_id))
                    return self.send_json({"id": order_id, "status": next_status})
                if path == "/api/products":
                    if not self.is_admin(db):
                        return self.send_json({"error": "Admin sign-in is required."}, 401)
                    if data.get("action") == "set-store-status":
                        store_open = bool(data.get("isOpen"))
                        db.execute("UPDATE store_settings SET setting_value=%s WHERE setting_key='is_open'", ("1" if store_open else "0",))
                        return self.send_json({"storeOpen": store_open})
                    product_id = str(data.get("id", "")).strip()
                    name = str(data.get("name", "")).strip()
                    description = str(data.get("description", "")).strip()
                    unit = str(data.get("unit", "")).strip()
                    image_data = str(data.get("imageData", ""))
                    category = data.get("category", "other")
                    try:
                        price = float(data.get("price"))
                        quantity = int(data.get("quantity"))
                    except (TypeError, ValueError):
                        return self.send_json({"error": "Enter a valid price and stock quantity."}, 400)
                    if not name or not description or not unit or price <= 0 or quantity < 0 or category not in {"milk", "curd", "ghee", "other"}:
                        return self.send_json({"error": "Complete all fields with a price above zero and quantity of zero or more."}, 400)
                    if image_data and (len(image_data) > 1500000 or not image_data.startswith("data:image/")):
                        return self.send_json({"error": "Choose a smaller image file in JPG, PNG or WebP format."}, 400)
                    if product_id:
                        exists = db.execute("SELECT 1 FROM products WHERE id=%s", (product_id,)).fetchone()
                        if not exists:
                            return self.send_json({"error": "That product could not be found."}, 404)
                        duplicate = db.execute("SELECT 1 FROM products WHERE name=%s AND id<>%s", (name, product_id)).fetchone()
                        if duplicate:
                            return self.send_json({"error": "Another product already uses that name."}, 409)
                        db.execute("UPDATE products SET name=%s, description=%s, price=%s, unit=%s, quantity=%s, category=%s, image_data=%s, active=1 WHERE id=%s",
                                   (name, description, price, unit, quantity, category, image_data, product_id))
                    else:
                        product_id = "product-" + secrets.token_hex(6)
                        db.execute("INSERT INTO products(id,name,description,price,unit,quantity,category,active,created_at,image_data) VALUES(%s,%s,%s,%s,%s,%s,%s,1,%s,%s)",
                                   (product_id, name, description, price, unit, quantity, category, datetime.now(timezone.utc).isoformat(), image_data))
                    return self.send_json({"message": "Product saved.", "id": product_id})
            self.send_json({"error": "Unknown endpoint."}, 404)
        except sqlite3.IntegrityError:
            self.send_json({"error": "A product with that name already exists."}, 409)
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            self.send_json({"error": "The submitted information is incomplete or invalid."}, 400)

    def do_DELETE(self):
        path = urlparse(self.path).path
        if path != "/api/products":
            return self.send_json({"error": "Unknown endpoint."}, 404)
        try:
            data = self.read_json()
            with connect() as db:
                if not self.is_admin(db):
                    return self.send_json({"error": "Admin sign-in is required."}, 401)
                product_id = str(data.get("id", ""))
                product = db.execute("SELECT id FROM products WHERE id=%s", (product_id,)).fetchone()
                if not product:
                    return self.send_json({"error": "We couldn’t find that product."}, 404)
                db.execute("UPDATE products SET active=0 WHERE id=%s", (product_id,))
            return self.send_json({"message": "Product removed from the consumer store."})
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            self.send_json({"error": "The submitted information is incomplete or invalid."}, 400)


if __name__ == "__main__":
    init_db()
    print(f"Ak's Dairy is running at http://localhost:{PORT}")
    for address in sorted(set(socket.gethostbyname_ex(socket.gethostname())[2])):
        if not address.startswith("127."):
            print(f"Phone / same Wi-Fi: http://{address}:{PORT}/admin.html")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
