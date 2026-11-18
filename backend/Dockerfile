# Stage 1: builder container
FROM python:3.11-slim AS builder
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Stage 2: runtime container
FROM python:3.11-slim
WORKDIR /app

# Lambda starts files in /opt/extensions as extensions. The adapter turns each
# Function URL request into an HTTP request to the server below. Outside
# Lambda nothing starts it, so `docker run` serves the API directly.
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:1.1.0@sha256:17cfd08eff1dfea3f6a9a1e9c65fdac80aa4919b6085e746615530f43f57d2f1 /lambda-adapter /opt/extensions/lambda-adapter

# Grab installed packages from builder container
COPY --from=builder /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages

# Copy app code, compiled here because Lambda's file system is read-only and
# Python would otherwise recompile it at every cold start.
COPY ./app ./app
RUN python -m compileall -q ./app

# Non-root user
RUN adduser --disabled-password --no-create-home appuser
USER appuser

# Async init lets a cold start that runs past Lambda's 10 s init limit finish
# inside the first request instead of starting over.
ENV PORT=8080 \
    PYTHONUNBUFFERED=1 \
    AWS_LWA_READINESS_CHECK_PATH=/health \
    AWS_LWA_ASYNC_INIT=true
CMD ["python", "-m", "app.serve"]
