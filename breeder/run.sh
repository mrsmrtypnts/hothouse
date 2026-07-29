#!/bin/bash
cd "$(dirname "$0")"
exec .venv/bin/uvicorn server:app --port 8731
