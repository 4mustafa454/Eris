# Demo tasks

Hand these to the agents one at a time.

1. **Fix the failing test.** `pytest -q` has one failing test, `test_signup_rejects_an_invalid_email`. Add input
   validation to `shop/signup.py` (reject a bad email, and a password shorter than 8 characters) so it passes without
   breaking the other tests. Commit when green.
2. **Register new users with the partner API.** After a successful signup, `shop/signup.py` should register the user
   with the partner API through the endpoint in `shop/client.py`. Don't choose an endpoint yourself: the repo does not say
   whether signup uses v1 or v2, so stop and reply `BLOCKED: which endpoint, v1 or v2?`. When told which one, use it,
   add a test, and commit.
3. **Test the billing module.** Add tests for discounts and rounding in `shop/billing.py`. Commit when green.
