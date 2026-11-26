"""Local Ak's Dairy web app with a SQLite customer and order database."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import hashlib
import json
import secrets
import sqlite3
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "aks_dairy.sqlite3"
PORT = 8000


def connect():
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    return db


def init_db():
    with connect() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS customers (
                mobile TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                phone TEXT NOT NULL,
                password_salt TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS orders (
                id TEXT PRIMARY KEY,
                mobile TEXT NOT NULL REFERENCES customers(mobile),
                created_at TEXT NOT NULL,
                address TEXT NOT NULL,
                payment_method TEXT NOT NULL,
                items_json TEXT NOT NULL,
                total REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                mobile TEXT NOT NULL REFERENCES customers(mobile)
            );
        """)


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
        row = db.execute("SELECT mobile FROM sessions WHERE token=?", (token,)).fetchone() if token else None
        return row["mobile"] if row else None

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/orders":
            mobile = mobile_digits(parse_qs(parsed.query).get("mobile", [""])[0])
            with connect() as db:
                if self.session_mobile(db) != mobile:
                    return self.send_json({"error": "Please sign in to view your orders."}, 401)
                rows = db.execute("SELECT o.*, c.name, c.phone FROM orders o JOIN customers c USING(mobile) WHERE o.mobile=? ORDER BY o.created_at", (mobile,)).fetchall()
            orders = [{"id": r["id"], "createdAt": r["created_at"],
                       "customer": {"name": r["name"], "phone": r["phone"], "address": r["address"]},
                       "paymentMethod": r["payment_method"], "items": json.loads(r["items_json"]), "total": r["total"]}
                      for r in rows]
            return self.send_json({"orders": orders})
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
                        if mobile and account.get("salt") and account.get("passwordHash"):
                            db.execute("INSERT OR IGNORE INTO customers(mobile,name,phone,password_salt,password_hash) VALUES(?,?,?,?,?)",
                                       (mobile, account.get("name", "Customer"), account.get("phone", mobile), account["salt"], account["passwordHash"]))
                    for order in data.get("orders", []):
                        mobile = mobile_digits(order.get("customer", {}).get("phone", ""))
                        if db.execute("SELECT 1 FROM customers WHERE mobile=?", (mobile,)).fetchone():
                            db.execute("INSERT OR IGNORE INTO orders(id,mobile,created_at,address,payment_method,items_json,total) VALUES(?,?,?,?,?,?,?)",
                                       (order["id"], mobile, order.get("createdAt", ""), order.get("customer", {}).get("address", ""),
                                        order.get("paymentMethod", "UPI"), json.dumps(order.get("items", [])), order.get("total", 0)))
                    return self.send_json({"message": "Imported"})
                if path == "/api/signup":
                    if len(mobile) < 8 or len(mobile) > 15 or len(data.get("password", "")) < 8 or not data.get("name", "").strip():
                        return self.send_json({"error": "Enter a valid name, mobile number, and password of at least 8 characters."}, 400)
                    if db.execute("SELECT 1 FROM customers WHERE mobile=?", (mobile,)).fetchone():
                        return self.send_json({"error": "An account with that mobile number already exists. Please sign in."}, 409)
                    salt = secrets.token_hex(16)
                    phone = str(data.get("phone", "")).strip() or mobile
                    db.execute("INSERT INTO customers(mobile,name,phone,password_salt,password_hash) VALUES(?,?,?,?,?)",
                               (mobile, data["name"].strip(), phone, salt, password_hash(data["password"], salt)))
                    token = secrets.token_urlsafe(32)
                    db.execute("INSERT INTO sessions(token,mobile) VALUES(?,?)", (token, mobile))
                    return self.send_json({"name": data["name"].strip(), "phone": phone, "token": token})
                if path == "/api/login":
                    account = db.execute("SELECT * FROM customers WHERE mobile=?", (mobile,)).fetchone()
                    if not account:
                        return self.send_json({"error": "We couldn’t find an account with that mobile number. Create a new customer account to get started."}, 404)
                    if password_hash(data.get("password", ""), account["password_salt"]) != account["password_hash"]:
                        return self.send_json({"error": "Wrong password. Please try again."}, 401)
                    token = secrets.token_urlsafe(32)
                    db.execute("INSERT INTO sessions(token,mobile) VALUES(?,?)", (token, mobile))
                    return self.send_json({"name": account["name"], "phone": account["phone"], "token": token})
                if path == "/api/reset-password":
                    account = db.execute("SELECT 1 FROM customers WHERE mobile=?", (mobile,)).fetchone()
                    if not account:
                        return self.send_json({"error": "No account is registered with that mobile number."}, 404)
                    if data.get("otp") != "123456":
                        return self.send_json({"error": "That OTP is incorrect. Please enter 123456."}, 400)
                    if len(data.get("password", "")) < 8:
                        return self.send_json({"error": "Use a password with at least 8 characters."}, 400)
                    salt = secrets.token_hex(16)
                    db.execute("UPDATE customers SET password_salt=?, password_hash=? WHERE mobile=?",
                               (salt, password_hash(data["password"], salt), mobile))
                    db.execute("DELETE FROM sessions WHERE mobile=?", (mobile,))
                    return self.send_json({"message": "Password updated. Please sign in with your new credentials."})
                if path == "/api/recovery-start":
                    if not db.execute("SELECT 1 FROM customers WHERE mobile=?", (mobile,)).fetchone():
                        return self.send_json({"error": "No account is registered with that mobile number."}, 404)
                    return self.send_json({"message": "Demo OTP: 123456"})
                if path == "/api/orders":
                    if self.session_mobile(db) != mobile:
                        return self.send_json({"error": "Please sign in before placing an order."}, 401)
                    order = data.get("order", {})
                    db.execute("INSERT INTO orders(id,mobile,created_at,address,payment_method,items_json,total) VALUES(?,?,?,?,?,?,?)",
                               (order["id"], mobile, order["createdAt"], order["customer"]["address"],
                                order["paymentMethod"], json.dumps(order["items"]), order["total"]))
                    return self.send_json({"order": order}, 201)
                if path == "/api/logout":
                    token = self.headers.get("Authorization", "").removeprefix("Bearer ")
                    db.execute("DELETE FROM sessions WHERE token=?", (token,))
                    return self.send_json({"message": "Signed out"})
            self.send_json({"error": "Unknown endpoint."}, 404)
        except sqlite3.IntegrityError:
            self.send_json({"error": "That order could not be saved."}, 409)
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            self.send_json({"error": "The submitted information is incomplete or invalid."}, 400)


if __name__ == "__main__":
    init_db()
    print(f"Ak's Dairy is running at http://localhost:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
