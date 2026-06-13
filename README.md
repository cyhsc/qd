# QD — Trading & Charting App

A React + FastAPI app for stock charting, screening, and scheduled agent tasks.

## Backend

Requires Python 3.11+ and [TA-Lib](https://ta-lib.org) installed system-wide.

```bash
# First time: create and populate the virtual environment
python3 -m venv venv
source venv/bin/activate
pip install -r backend/requirements.txt

# Start the dev server (from the repo root)
source venv/bin/activate
cd backend
python main.py
```

The API is served at `http://localhost:8000`. Interactive docs at `http://localhost:8000/docs`.

## Frontend

Requires Node.js and [Yarn](https://yarnpkg.com).

```bash
cd frontend
yarn install   # first time only
yarn dev 
```

The app is served at `http://localhost:3001` or whatever is displayed.

> Port 3001 wll be used if port 3000 is occupied by another local service.
