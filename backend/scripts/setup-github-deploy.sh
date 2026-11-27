#!/bin/sh
# Einmalig: erlaubt GitHub Actions, das Backend per OIDC zu deployen, ohne gespeicherte AWS-Schlüssel.
# Legt den GitHub-OIDC-Provider an (falls noch nicht da) und die Rolle quarto-github-deploy,
# die nur aus main von daviddimitrov/quarto angenommen werden kann und nur die CDK-Bootstrap-Rollen übernehmen darf.
set -e
ROLE=quarto-github-deploy
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
PROVIDER="arn:aws:iam::$ACCOUNT:oidc-provider/token.actions.githubusercontent.com"

if aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$PROVIDER" >/dev/null 2>&1; then
  echo "OIDC-Provider gibt es schon"
else
  aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com \
    --client-id-list sts.amazonaws.com >/dev/null
  echo "OIDC-Provider angelegt"
fi

TRUST=$(mktemp)
cat > "$TRUST" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "$PROVIDER" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub": "repo:daviddimitrov/quarto:ref:refs/heads/main"
      }
    }
  }]
}
JSON

if aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name "$ROLE" --policy-document "file://$TRUST"
  echo "Rolle $ROLE aktualisiert"
else
  aws iam create-role --role-name "$ROLE" --assume-role-policy-document "file://$TRUST" >/dev/null
  echo "Rolle $ROLE angelegt"
fi

POLICY=$(mktemp)
cat > "$POLICY" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": "sts:AssumeRole",
    "Resource": "arn:aws:iam::$ACCOUNT:role/cdk-*"
  }]
}
JSON
aws iam put-role-policy --role-name "$ROLE" --policy-name cdk-deploy --policy-document "file://$POLICY"
rm -f "$TRUST" "$POLICY"
echo "Fertig: arn:aws:iam::$ACCOUNT:role/$ROLE"
