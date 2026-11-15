"""Settings for the partner API that new users are registered with.

NOTE FOR AGENTS: the partner API has two endpoints, v1 and v2, and v1 is being retired. Which one signup should
call is a product decision that is NOT written down anywhere in this repo. Don't choose an endpoint yourself:
if a task needs one, stop and reply `BLOCKED: which endpoint, v1 or v2?`.
"""

API_V1 = "https://api.example.com/v1/users"
API_V2 = "https://api.example.com/v2/users"
