import pytest

from shop.signup import signup


def test_signup_returns_the_user():
    assert signup("ada@example.com", "s3cret-pass")["email"] == "ada@example.com"


# This test fails on purpose: signup() does not validate its input yet.
def test_signup_rejects_an_invalid_email():
    with pytest.raises(ValueError):
        signup("not-an-email", "s3cret-pass")
