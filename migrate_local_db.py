"""Copy the local SQLite customers, orders, and sessions into hosted Postgres."""
import os
import sqlite3
from server import DATABASE_URL, DB_PATH, connect, init_db


def main():
    if not DATABASE_URL:
        raise SystemExit("Set DATABASE_URL to the hosted Postgres connection string first.")
    if not DB_PATH.exists():
        raise SystemExit(f"No local database found at {DB_PATH}")

    source = sqlite3.connect(DB_PATH)
    source.row_factory = sqlite3.Row
    customers = source.execute("SELECT mobile,name,phone,password_salt,password_hash,created_at FROM customers").fetchall()
    orders = source.execute("SELECT id,mobile,created_at,address,payment_method,items_json,total FROM orders").fetchall()
    sessions = source.execute("SELECT token,mobile FROM sessions").fetchall()
    has_deletions = source.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='deleted_customers'").fetchone()
    deleted_customers = source.execute("SELECT mobile,deleted_at FROM deleted_customers").fetchall() if has_deletions else []
    has_products = source.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='products'").fetchone()
    products = []
    if has_products:
        product_columns = {row[1] for row in source.execute("PRAGMA table_info(products)").fetchall()}
        image_column = ",image_data" if "image_data" in product_columns else ",'' AS image_data"
        products = source.execute("SELECT id,name,description,price,unit,quantity,category,active,created_at" + image_column + " FROM products").fetchall()
    has_settings = source.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='store_settings'").fetchone()
    store_settings = source.execute("SELECT setting_key,setting_value FROM store_settings").fetchall() if has_settings else []
    source.close()

    init_db()
    with connect() as target:
        for row in customers:
            target.execute("INSERT INTO customers(mobile,name,phone,password_salt,password_hash,created_at) VALUES(%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING", tuple(row))
        for row in orders:
            target.execute("INSERT INTO orders(id,mobile,created_at,address,payment_method,items_json,total) VALUES(%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING", tuple(row))
        for row in sessions:
            target.execute("INSERT INTO sessions(token,mobile) VALUES(%s,%s) ON CONFLICT DO NOTHING", tuple(row))
        for row in deleted_customers:
            target.execute("INSERT INTO deleted_customers(mobile,deleted_at) VALUES(%s,%s) ON CONFLICT DO NOTHING", tuple(row))
        for row in products:
            target.execute("INSERT INTO products(id,name,description,price,unit,quantity,category,active,created_at,image_data) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description, price=EXCLUDED.price, unit=EXCLUDED.unit, quantity=EXCLUDED.quantity, category=EXCLUDED.category, active=EXCLUDED.active, image_data=EXCLUDED.image_data", tuple(row))
        for row in store_settings:
            target.execute("INSERT INTO store_settings(setting_key,setting_value) VALUES(%s,%s) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value", tuple(row))
    print(f"Imported {len(customers)} customers, {len(orders)} orders, and {len(products)} products; preserved {len(deleted_customers)} customer deletion records and {len(store_settings)} settings.")


if __name__ == "__main__":
    main()
