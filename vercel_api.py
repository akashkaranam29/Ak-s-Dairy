"""Shared handler used by the individual Vercel API routes."""
from server import Handler, init_db

init_db()


class VercelHandler(Handler):
    pass
