import os
import json
import google.generativeai as genai
from dotenv import load_dotenv
from flask_cors import CORS

# --- Load Environment Variables ---
load_dotenv()

# --- AI Configuration ---
API_KEY = os.getenv("GEMINI_API_KEY")
if not API_KEY:
    raise ValueError("CRITICAL: GEMINI_API_KEY is missing from the .env file!")

genai.configure(api_key=API_KEY)
model = genai.GenerativeModel('gemini-2.5-flash')


import logging
import math
from typing import Dict, List, Tuple

import networkx as nx
from flask import Flask, jsonify, request
from shapely import wkt
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from database import DATABASE_URL


APP_PORT = 5002
BUFFER_METERS = 2_000
MIN_WEIGHT_DENOMINATOR = 1
REVIEW_SEARCH_RADIUS_METERS = 50


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)
engine = create_engine(DATABASE_URL, future=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


def parse_lat_lon(value: str, field_name: str) -> Tuple[float, float]:
    try:
        lat_str, lon_str = value.split(",")
        return float(lat_str.strip()), float(lon_str.strip())
    except Exception as exc:
        raise ValueError(f"{field_name} must be provided as 'lat,lon'.") from exc


def haversine_distance_meters(point_a: Tuple[float, float], point_b: Tuple[float, float]) -> float:
    lat1, lon1 = map(math.radians, point_a)
    lat2, lon2 = map(math.radians, point_b)
    delta_lat = lat2 - lat1
    delta_lon = lon2 - lon1

    a = (
        math.sin(delta_lat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(delta_lon / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return 6_371_000 * c


def initialize_database_state() -> None:
    logger.info("Initializing routing database state...")
    with engine.begin() as connection:
        connection.execute(
            text(
                """
                ALTER TABLE street_edges
                ADD COLUMN IF NOT EXISTS crowdsource_modifier INTEGER NOT NULL DEFAULT 0
                """
            )
        )
        connection.execute(
            text(
                """
                ALTER TABLE street_edges
                ADD COLUMN IF NOT EXISTS latest_report_summary TEXT
                """
            )
        )
        connection.execute(
            text(
                """
                ALTER TABLE street_edges
                ADD COLUMN IF NOT EXISTS latest_report_time_context VARCHAR(16)
                """
            )
        )

        initialized_count = connection.execute(
            text(
                """
                UPDATE street_edges
                SET base_safety_score = FLOOR(random() * 41 + 40)::INTEGER
                """
            )
        ).rowcount

    logger.info(
        "Startup initialization complete. Baseline safety score randomized for %s edge(s).",
        initialized_count,
    )


def fetch_edges_for_corridor(
    start: Tuple[float, float],
    end: Tuple[float, float],
) -> List[Dict]:
    logger.info("Fetching candidate edges within the %sm corridor bounding box...", BUFFER_METERS)
    sql = text(
        """
        WITH corridor AS (
            SELECT ST_Expand(
                ST_MakeEnvelope(
                    LEAST(:start_lon, :end_lon),
                    LEAST(:start_lat, :end_lat),
                    GREATEST(:start_lon, :end_lon),
                    GREATEST(:start_lat, :end_lat),
                    4326
                ),
                :buffer_degrees
            ) AS bbox
        )
        SELECT
            id,
            start_node,
            end_node,
            base_safety_score,
            crowdsource_modifier,
            latest_report_summary,
            latest_report_time_context,
            ST_AsText(geometry) AS geometry_wkt,
            ST_Length(geometry::geography) AS length_meters
        FROM street_edges, corridor
        WHERE geometry && corridor.bbox
          AND ST_Intersects(geometry, corridor.bbox)
        """
    )

    avg_lat = (start[0] + end[0]) / 2
    buffer_degrees = BUFFER_METERS / (111_320 * max(math.cos(math.radians(avg_lat)), 0.2))

    with engine.connect() as connection:
        rows = connection.execute(
            sql,
            {
                "start_lat": start[0],
                "start_lon": start[1],
                "end_lat": end[0],
                "end_lon": end[1],
                "buffer_degrees": buffer_degrees,
            },
        ).mappings().all()

    logger.info("Loaded %s candidate edge(s) from PostGIS.", len(rows))
    return [dict(row) for row in rows]


def build_graph(edges: List[Dict]) -> Tuple[nx.DiGraph, Dict[int, Tuple[float, float]]]:
    graph = nx.DiGraph()
    node_positions: Dict[int, Tuple[float, float]] = {}

    for edge in edges:
        geometry = wkt.loads(edge["geometry_wkt"])
        coordinates = list(geometry.coords)

        if len(coordinates) < 2:
            continue

        start_coord = coordinates[0]
        end_coord = coordinates[-1]

        node_positions.setdefault(edge["start_node"], (start_coord[1], start_coord[0]))
        node_positions.setdefault(edge["end_node"], (end_coord[1], end_coord[0]))

        # --- THE MATH TWEAK: Exponential Safety Penalty ---
        total_safety = edge["base_safety_score"] + edge["crowdsource_modifier"]
        length = float(edge["length_meters"])
        
        # If safety is normal (1 to 100+), use standard cost
        if total_safety > 0:
            safe_score = max(1, total_safety)
            weight = max(length / safe_score, 0.0001)
        # If crowdsourcing drops safety to 0 or below, apply massive exponential penalty
        else:
            # Every negative point doubles the perceived length of the road
            penalty_multiplier = 2 ** abs(total_safety)
            weight = length * penalty_multiplier
        # --------------------------------------------------

        existing = graph.get_edge_data(edge["start_node"], edge["end_node"])
        if existing is None or weight < existing["weight"]:
            graph.add_edge(
                edge["start_node"],
                edge["end_node"],
                edge_id=edge["id"],
                geometry=coordinates,
                length=float(edge["length_meters"]),
                length_meters=float(edge["length_meters"]),
                base_safety_score=int(edge["base_safety_score"]),
                crowdsource_modifier=int(edge["crowdsource_modifier"]),
                total_score=int(edge["base_safety_score"] + edge["crowdsource_modifier"]),
                latest_report_summary=edge.get("latest_report_summary"),
                latest_report_time_context=edge.get("latest_report_time_context"),
                weight=weight,
            )

    return graph, node_positions


def find_nearest_node(
    target: Tuple[float, float],
    node_positions: Dict[int, Tuple[float, float]],
) -> int:
    nearest_node = min(
        node_positions,
        key=lambda node_id: haversine_distance_meters(target, node_positions[node_id]),
    )
    return nearest_node


def path_to_geojson(graph: nx.DiGraph, node_path: List[int]) -> Dict:
    route_features: List[Dict] = []

    for start_node, end_node in zip(node_path[:-1], node_path[1:]):
        edge_data = graph.get_edge_data(start_node, end_node)
        segment = edge_data["geometry"]

        route_features.append(
            {
                "type": "Feature",
                "properties": {
                    "edge_id": edge_data["edge_id"],
                    "length_meters": edge_data["length_meters"],
                    "base_safety_score": edge_data["base_safety_score"],
                    "crowdsource_modifier": edge_data["crowdsource_modifier"],
                    "total_score": edge_data["total_score"],
                    **(
                        {
                            "report_summary": edge_data.get("latest_report_summary"),
                            "time_context": edge_data.get("latest_report_time_context") or "Unknown",
                        }
                        if edge_data["total_score"] < 40 and edge_data.get("latest_report_summary")
                        else {}
                    ),
                },
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[lon, lat] for lon, lat in segment],
                },
            }
        )

    return {
        "type": "FeatureCollection",
        "features": route_features,
    }


def calculate_route_metrics(route_feature_collection: Dict) -> Dict:
    features = route_feature_collection.get("features", [])
    if not features:
        return {
            "total_length_meters": 0.0,
            "average_safety_score": 0.0,
        }

    total_length_meters = sum(
        float(feature.get("properties", {}).get("length_meters", 0.0))
        for feature in features
    )
    average_safety_score = sum(
        float(feature.get("properties", {}).get("total_score", 0.0))
        for feature in features
    ) / len(features)

    return {
        "total_length_meters": total_length_meters,
        "average_safety_score": average_safety_score,
    }


@app.get("/api/v2/route")
def route() -> Tuple[Dict, int] | Tuple[object, int]:
    start_value = request.args.get("start")
    end_value = request.args.get("end")

    if not start_value or not end_value:
        return jsonify({"error": "Both 'start' and 'end' query parameters are required."}), 400

    try:
        start = parse_lat_lon(start_value, "start")
        end = parse_lat_lon(end_value, "end")
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    try:
        edges = fetch_edges_for_corridor(start, end)
        if not edges:
            return jsonify({"error": "No candidate edges found in the requested corridor."}), 404

        graph, node_positions = build_graph(edges)
        if graph.number_of_edges() == 0 or not node_positions:
            return jsonify({"error": "Unable to construct a routable graph from the candidate edges."}), 404

        start_node = find_nearest_node(start, node_positions)
        end_node = find_nearest_node(end, node_positions)

        logger.info("Routing from graph node %s to %s...", start_node, end_node)
        standard_path = nx.shortest_path(graph, source=start_node, target=end_node, weight="length")
        safe_path = nx.shortest_path(graph, source=start_node, target=end_node, weight="weight")

        standard_route = path_to_geojson(graph, standard_path)
        safe_route = path_to_geojson(graph, safe_path)
        standard_metrics = calculate_route_metrics(standard_route)
        safe_metrics = calculate_route_metrics(safe_route)

        return (
            jsonify(
                {
                    "standard": {
                        "geojson": standard_route,
                        "metrics": standard_metrics,
                    },
                    "safe": {
                        "geojson": safe_route,
                        "metrics": safe_metrics,
                    },
                    "start_node": start_node,
                    "end_node": end_node,
                    "graph_edge_count": graph.number_of_edges(),
                }
            ),
            200,
        )
    except nx.NetworkXNoPath:
        return jsonify({"error": "No path found between the requested points in the current corridor."}), 404
    except Exception:
        logger.exception("Route computation failed.")
        return jsonify({"error": "Route computation failed."}), 500


def analyze_safety_review(review_text: str) -> Dict[str, str | int]:
    """Uses LLM to parse a user review and return structured safety metadata."""
    prompt = f"""
    You are a safety analysis AI for a night navigation app.
    Analyze this user review and return ONLY valid JSON with exactly these keys:
    {{
      "penalty_score": integer,
      "time_context": string,
      "report_summary": string
    }}

    Scoring rules:
    - Return an integer from 20 to -100.
    - Positive scores are allowed only for clearly reassuring signals like families present, a busy market, active shops, or other safe/public activity.
    - Unsafe crowds such as drunk people, aggressive groups, stalking, harassment, or groups acting weird should cause a strong negative penalty.
    - Dim lighting, isolation, or broken streetlights should reduce the score even if no crowd is mentioned.
    - If there is immediate danger, use a very large negative penalty.

    Time rules:
    - Look carefully for any timestamp or time-of-day reference such as "at 2 AM", "around 11:30 pm", or "late night".
    - If an exact time is present, normalize it to 24-hour HH:MM format.
    - If there is no usable time, return "Unknown".

    Summary rules:
    - report_summary must be one short sentence suitable for attaching to a dangerous street segment.
    - It should summarize the reported issue, for example: "User reported drunk individuals and broken streetlights here."

    Review: "{review_text}"
    """
    try:
        response = model.generate_content(prompt)
        raw_text = response.text.strip()
        cleaned_text = raw_text.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        parsed = json.loads(cleaned_text)
        score = int(parsed.get("penalty_score", -20))
        return {
            "penalty_score": max(-100, min(20, score)),
            "time_context": str(parsed.get("time_context") or "Unknown"),
            "report_summary": str(parsed.get("report_summary") or "User reported a safety concern here."),
        }
    except Exception as exc:
        logger.error(f"LLM parsing failed: {exc}")
        return {
            "penalty_score": -20,
            "time_context": "Unknown",
            "report_summary": "User reported a safety concern here.",
        }

@app.post("/api/v2/review")
def review() -> Tuple[object, int]:
    payload = request.get_json(silent=True) or {}
    lat = payload.get("lat")
    lon = payload.get("lon")
    review_text = payload.get("review")

    if lat is None or lon is None or not review_text:
        return jsonify({"error": "JSON body must include 'lat', 'lon', and 'review' text."}), 400

    # --- AI NLP Analysis ---
    analysis = analyze_safety_review(review_text)
    modifier_delta = int(analysis["penalty_score"])
    logger.info(
        "AI assigned penalty of %s with time context %s for review: '%s'",
        modifier_delta,
        analysis["time_context"],
        review_text,
    )

    sql = text(
        """
        WITH nearest_edge AS (
            SELECT id
            FROM street_edges
            WHERE ST_DWithin(
                geometry::geography,
                ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography,
                :radius_meters
            )
            ORDER BY ST_Distance(
                geometry::geography,
                ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography
            )
            LIMIT 1
        )
        UPDATE street_edges
        SET
            crowdsource_modifier = crowdsource_modifier + :modifier_delta,
            latest_report_summary = :report_summary,
            latest_report_time_context = :time_context
        WHERE id IN (SELECT id FROM nearest_edge)
        RETURNING id, crowdsource_modifier, latest_report_summary, latest_report_time_context
        """
    )

    with SessionLocal() as session:
        try:
            result = session.execute(
                sql,
                {
                    "lat": lat,
                    "lon": lon,
                    "radius_meters": REVIEW_SEARCH_RADIUS_METERS,
                    "modifier_delta": modifier_delta,
                    "report_summary": analysis["report_summary"],
                    "time_context": analysis["time_context"],
                },
            ).mappings().first()

            if result is None:
                session.rollback()
                return jsonify({"error": "No street edge found near the supplied coordinates."}), 404

            session.commit()
            return (
                jsonify(
                    {
                        "edge_id": result["id"],
                        "ai_penalty_applied": modifier_delta,
                        "new_total_modifier": result["crowdsource_modifier"],
                        "report_summary": result["latest_report_summary"],
                        "time_context": result["latest_report_time_context"],
                    }
                ),
                200,
            )
        except Exception as exc:
            session.rollback()
            logger.exception("Crowdsourced review update failed.")
            return jsonify({"error": "Failed to record review."}), 500



if __name__ == "__main__":
    initialize_database_state()
    app.run(host="0.0.0.0", port=APP_PORT, debug=True)
