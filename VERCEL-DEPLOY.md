# Deploy Ak’s Dairy to Vercel

The storefront and Python API deploy from this repository. Local development uses `aks_dairy.sqlite3`; Vercel uses a persistent hosted PostgreSQL database.

1. Push this folder to GitHub and import the repository in Vercel.
2. In the Vercel project, add a PostgreSQL database from the Marketplace (Neon is supported). Ensure the project has a connection string named `POSTGRES_URL` or `DATABASE_URL` for Production and Preview.
3. Deploy. The API creates the `customers`, `orders`, and `sessions` tables on first use. Passwords are stored as salted hashes.
4. Set `ADMIN_MOBILE=7382756905` and `ADMIN_PASSWORD` in Vercel Project Settings → Environment Variables, then redeploy. The local admin page uses the provided demo password `123456`; for a public deployment, choose a private admin password in Vercel.

Do not commit a database connection string or password to Git. Keep the fixed OTP `123456` for demo use only; replace it with real mobile verification before taking real customer accounts.

If you already have customers in the local SQLite file, install the packages in `requirements.txt`, set `DATABASE_URL` in your terminal to the hosted database URL, then run `python migrate_local_db.py` once before using the deployed site. This copies customers, password hashes, orders, and sessions; it does not delete the local database.
