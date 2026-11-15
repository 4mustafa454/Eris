"""Signup endpoint logic."""


def signup(email, password):
    """Create a user and return the new user record."""
    return {"email": email, "password": password}
