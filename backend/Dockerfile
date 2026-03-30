# Stage 1: builder container
FROM python:3.11-slim AS builder
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Stage 2: runtime container
FROM python:3.11-slim
WORKDIR /app

# Grab installed packages from builder container
COPY --from=builder /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
COPY --from=builder /usr/local/bin/uvicorn /usr/local/bin/uvicorn

# Copy app code
COPY ./app ./app

# Non-root user
RUN adduser --disabled-password --no-create-home appuser
USER appuser


ENV PORT=8080
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port $PORT"]