from fastapi.testclient import TestClient
from app.main import app


def test_dashboard_origins_can_make_json_requests(db_file):
    with TestClient(app) as client:
        response = client.options('/tasks', headers={'Origin': 'http://localhost:5173', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type'})
        assert response.status_code == 200
        assert response.headers['access-control-allow-origin'] == 'http://localhost:5173'
        rejected = client.options('/tasks', headers={'Origin': 'https://example.com', 'Access-Control-Request-Method': 'POST'})
        assert rejected.status_code == 400
