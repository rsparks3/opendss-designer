"""A proxy may withhold the planning studies per plan, like the converter:
`features.studies` in the trusted limits header turns every study route
into a 403 with the proxy's sentence, and /api/health says so."""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from opendss_designer import server
from opendss_designer.settings import reload_settings

HEADER = "x-opendss-limits"
REASON = "Planning studies are part of the Pro plan. Upgrade from your account page."

CIRCUIT = {"name": "t", "nodes": [], "edges": []}


@pytest.fixture()
def gated(tmp_path, monkeypatch):
    static = tmp_path / "static"
    (static / "assets").mkdir(parents=True)
    (static / "index.html").write_text("SPA", encoding="utf-8")
    monkeypatch.setattr(server, "STATIC_DIR", static)
    cfg = reload_settings({"OPENDSS_DESIGNER_MODE": "demo",
                           "OPENDSS_DESIGNER_TRUSTED_LIMITS_HEADER": HEADER})
    try:
        yield TestClient(server.create_app(cfg), base_url="http://127.0.0.1")
    finally:
        reload_settings({})


def _withheld(value) -> dict:
    return {HEADER: json.dumps({"plan": {"name": "Free"}, "features": {"studies": value}})}


@pytest.mark.parametrize("path", ["/api/jobs/batch", "/api/jobs/n-minus-1", "/api/jobs/hosting-capacity",
                                  "/api/cvr", "/api/capacity", "/api/faultpoint", "/api/allocate",
                                  "/api/fusesaving", "/api/rvc", "/api/screen"])
def test_a_withheld_study_is_a_403_with_the_proxys_reason(gated, path):
    # Validation runs first, so every body carries what its route requires.
    r = gated.post(path, json={"circuit": CIRCUIT, "bus": "x", "options": {}, "rows": []},
                   headers=_withheld(REASON))
    assert r.status_code == 403, r.text
    assert r.json()["detail"] == REASON


def test_withheld_without_words_gets_the_generic_sentence(gated):
    r = gated.post("/api/jobs/batch", json={"circuit": CIRCUIT}, headers=_withheld(False))
    assert r.status_code == 403
    assert "Planning studies is not included in the Free plan." == r.json()["detail"]


def test_health_names_the_withheld_feature(gated):
    body = gated.get("/api/health", headers=_withheld(REASON)).json()
    assert body["features"]["studies"] == {"locked": True, "reason": REASON}
    body = gated.get("/api/health", headers={HEADER: json.dumps({"plan": {"name": "Free"}})}).json()
    assert "features" not in body


def test_what_is_not_a_study_stays_open(gated):
    r = gated.post("/api/qa", json={"circuit": CIRCUIT}, headers=_withheld(REASON))
    assert r.status_code != 403, r.text
    r = gated.get("/api/catalog/wires", headers=_withheld(REASON))
    assert r.status_code == 200
