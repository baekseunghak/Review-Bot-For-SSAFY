FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONNOUSERSITE=1
RUN apt-get update && apt-get install -y --no-install-recommends libexpat1 \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt /opt/requirements.txt
RUN pip install --no-cache-dir --only-binary=:all: -r /opt/requirements.txt pytest==9.1.1 \
    && tr -d '\r' < /opt/requirements.txt | sha256sum | cut -d ' ' -f 1 > /opt/python-lock.sha256
