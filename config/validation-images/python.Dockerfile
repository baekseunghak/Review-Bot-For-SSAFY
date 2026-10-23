FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONNOUSERSITE=1
COPY requirements.txt /opt/requirements.txt
RUN pip install --no-cache-dir --only-binary=:all: -r /opt/requirements.txt \
    && tr -d '\r' < /opt/requirements.txt | sha256sum | cut -d ' ' -f 1 > /opt/python-lock.sha256
