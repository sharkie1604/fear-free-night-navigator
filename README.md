Night Navigator
Night Navigator is an AI-powered, dual-routing geospatial engine designed to prioritize "Psychological Safety" for nighttime commuters. Built for Google The Big Code 2026.

Quick Start: Environment Setup & Running the Code
Prerequisites
Docker (for PostGIS)
Python 3.10+
Node.js v18+

API Keys required: Mapbox GL JS, Google Gemini API

(Note: All commands below should be run from the root directory of the project).

1. Database Setup (PostGIS)
We use a Dockerized PostGIS instance to handle spatial indexing for the Bengaluru OSM data.
Run this command:
docker-compose up -d

2. Backend Setup (Python API)
The custom graph engine and Gemini NLP pipeline run via Python.
Run these commands:
source .venv/bin/activate
pip install -r requirements.txt
python graph_engine.py

(If you are on Windows, use .venv\Scripts\activate to activate the environment).
The API will start and listen for routing requests on http://localhost:5002.

3. Frontend Setup (React)
The Enterprise Safety Dashboard is built with Vite + React.
Open a new terminal tab in the root directory and run these commands:
npm install
npm run dev

(Ensure your MAPBOX_TOKEN is in your .env file before running).

Core Logic & Architecture
Unlike standard navigation apps that optimize purely for distance, Night Navigator utilizes a Dynamic Safety Heuristic.

The Graph Engine: We load the Bengaluru street network into an in-memory NetworkX graph.

NLP Data Structuring: When a user submits a natural-language "Danger Ping", the text is parsed by the Google Gemini API. Gemini extracts the temporal context and intent (e.g., differentiating a "safe crowd" from a "threatening crowd") and outputs a structured JSON penalty_score.

Dynamic Graph Weighting: This penalty is injected into PostGIS, instantly increasing the mathematical cost of that specific street edge.

Modified Dijkstra: Our routing algorithm recalculates the path, actively bending the route away from high-penalty zones to find the psychologically safest corridor.

Demonstrable Reliability & Scalability
Sub-500ms Latency: To maintain real-time routing suitable for edge devices, we do not load all 400,000 edges for every request. We offload spatial bounds testing to PostGIS GIST indexes, pulling only the relevant sub-graph into Python memory for Dijkstra traversal.

Error Handling (AI Hallucinations): The Gemini prompt is strictly constrained to output JSON. If the NLP pipeline fails to parse a confusing user report, the system falls back to the baseline structural safety score derived from OpenStreetMap (OSM) metadata.

Data Strategy: Because real-time civic IoT data (e.g., streetlight outages) is unavailable, we engineered a synthetic proxy dataset. We use OSM metadata (primary vs. unclassified roads) as a baseline proxy for lighting, and our Gemini-powered crowdsourcing loop as the dynamic real-time layer.

Built by Aryan Chauhan
