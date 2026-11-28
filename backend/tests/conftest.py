"""Gemeinsame Fixtures: DynamoDB per moto, nichts geht ins Netz."""

import json
import os

os.environ.setdefault("AWS_DEFAULT_REGION", "eu-central-1")
os.environ.setdefault("AWS_ACCESS_KEY_ID", "test")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "test")
os.environ["TABLE_NAME"] = "quarto-test"
os.environ["TMDB_TOKEN"] = "tmdb-test"

import boto3
import pytest
from moto import mock_aws

# Der Mock muss laufen, bevor die Module ihre DynamoDB-Ressource anlegen
_mock = mock_aws()
_mock.start()

import api
import collect_today
import planta
import push

USER = "u1"


@pytest.fixture(autouse=True)
def db():
    ddb = boto3.client("dynamodb")
    ddb.create_table(
        TableName="quarto-test",
        KeySchema=[{"AttributeName": "PK", "KeyType": "HASH"}, {"AttributeName": "SK", "KeyType": "RANGE"}],
        AttributeDefinitions=[
            {"AttributeName": "PK", "AttributeType": "S"},
            {"AttributeName": "SK", "AttributeType": "S"},
        ],
        BillingMode="PAY_PER_REQUEST",
    )
    api._LOGIN_CACHE.clear()
    api._KEY_CACHE.clear()
    yield collect_today.table
    ddb.delete_table(TableName="quarto-test")


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    """Push, Planta und TMDB dürfen in Tests nie echte Anfragen stellen."""
    sent = []
    monkeypatch.setattr(push, "send", lambda sub, msg, urgency="normal": sent.append(msg) or 201)

    def planta_offline(*a, **k):
        raise AssertionError("Planta-Anfrage ohne Mock")

    monkeypatch.setattr(planta, "request", planta_offline)
    return sent


@pytest.fixture
def profile(db):
    item = {"PK": f"USER#{USER}", "SK": "PROFILE", "name": "David", "default_duration": 15, "max_duration": 30}
    db.put_item(Item=item)
    return item


def add_task(db, task_id, **fields):
    item = {"PK": f"USER#{USER}", "SK": f"TASK#{task_id}", "id": task_id, "name": task_id, "today": 0, **fields}
    db.put_item(Item=item)
    return item


def call(route, body=None, path=None, query=None, login="david", headers=None):
    """Ruft api.lambda_handler wie das HTTP-API mit Cognito-Claims auf."""
    event = {
        "routeKey": route,
        "body": json.dumps(body) if body is not None else None,
        "pathParameters": {"userId": USER, **(path or {})},
        "queryStringParameters": query,
        "headers": headers or {},
        "requestContext": {"authorizer": {"jwt": {"claims": {"cognito:username": login}}}},
    }
    resp = api.lambda_handler(event, None)
    return resp["statusCode"], json.loads(resp["body"])
