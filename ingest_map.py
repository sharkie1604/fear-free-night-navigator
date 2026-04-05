import logging
import math
from typing import Dict, Iterable, Iterator, List, Optional, Tuple

import osmnx as ox
from psycopg2.extras import execute_values
from shapely.geometry import LineString
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine

from database import DATABASE_URL


PLACE_NAME = "Bengaluru, Karnataka, India"
BATCH_SIZE = 10_000
DEFAULT_SAFETY_SCORE = 50


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)


def chunked(items: List[Tuple[int, int, str, int]], size: int) -> Iterator[List[Tuple[int, int, str, int]]]:
    for start in range(0, len(items), size):
        yield items[start : start + size]


def build_linestring_from_nodes(
    start_node: int,
    end_node: int,
    node_lookup: Dict[int, Dict[str, float]],
) -> Optional[LineString]:
    start = node_lookup.get(start_node)
    end = node_lookup.get(end_node)

    if not start or not end:
        return None

    return LineString(
        [
            (start["x"], start["y"]),
            (end["x"], end["y"]),
        ]
    )


def extract_edge_rows(graph) -> List[Tuple[int, int, str, int]]:
    logger.info("Extracting nodes for geometry fallback...")
    node_lookup = {node_id: data for node_id, data in graph.nodes(data=True)}

    logger.info("Extracting edges from graph...")
    rows: List[Tuple[int, int, str, int]] = []
    skipped_edges = 0
    total_edges = graph.number_of_edges()

    for index, (start_node, end_node, _key, data) in enumerate(graph.edges(keys=True, data=True), start=1):
        geometry = data.get("geometry")

        if geometry is None:
            geometry = build_linestring_from_nodes(start_node, end_node, node_lookup)

        if geometry is None:
            skipped_edges += 1
            logger.warning(
                "Skipping edge %s -> %s because no geometry was available.",
                start_node,
                end_node,
            )
            continue

        if geometry.geom_type != "LineString":
            try:
                geometry = LineString(geometry.coords)
            except Exception:
                skipped_edges += 1
                logger.warning(
                    "Skipping edge %s -> %s because geometry type %s could not be converted to LineString.",
                    start_node,
                    end_node,
                    getattr(geometry, "geom_type", "unknown"),
                )
                continue

        rows.append(
            (
                int(start_node),
                int(end_node),
                geometry.wkt,
                DEFAULT_SAFETY_SCORE,
            )
        )

        if index % 25_000 == 0 or index == total_edges:
            logger.info(
                "Prepared %s/%s edges for insertion. Skipped so far: %s.",
                index,
                total_edges,
                skipped_edges,
            )

    logger.info("Edge extraction complete. Prepared %s rows and skipped %s edges.", len(rows), skipped_edges)
    return rows


def insert_rows(engine: Engine, rows: List[Tuple[int, int, str, int]]) -> None:
    if not rows:
        logger.warning("No rows were prepared, so nothing will be inserted.")
        return

    total_batches = math.ceil(len(rows) / BATCH_SIZE)
    logger.info("Starting database insert across %s batch(es)...", total_batches)

    connection = engine.raw_connection()
    try:
        with connection.cursor() as cursor:
            for batch_number, batch in enumerate(chunked(rows, BATCH_SIZE), start=1):
                logger.info("Inserting batch %s/%s with %s rows...", batch_number, total_batches, len(batch))
                execute_values(
                    cursor,
                    """
                    INSERT INTO street_edges (start_node, end_node, geometry, base_safety_score)
                    VALUES %s
                    """,
                    batch,
                    template="(%s, %s, ST_GeomFromText(%s, 4326), %s)",
                    page_size=BATCH_SIZE,
                )
                connection.commit()
                logger.info("Finished batch %s/%s.", batch_number, total_batches)
    except Exception:
        connection.rollback()
        logger.exception("Database insertion failed.")
        raise
    finally:
        connection.close()


def ensure_database_ready(engine: Engine) -> None:
    logger.info("Checking database connectivity...")
    with engine.connect() as connection:
        connection.execute(text("SELECT 1"))
    logger.info("Database connection OK.")


def main() -> None:
    logger.info("Downloading graph for %s...", PLACE_NAME)
    graph = ox.graph_from_place(PLACE_NAME, network_type="drive")
    logger.info(
        "Graph downloaded successfully with %s nodes and %s edges.",
        graph.number_of_nodes(),
        graph.number_of_edges(),
    )

    rows = extract_edge_rows(graph)

    logger.info("Creating database engine...")
    engine = create_engine(DATABASE_URL)
    ensure_database_ready(engine)

    insert_rows(engine, rows)
    logger.info("Ingestion complete. Inserted %s street edges.", len(rows))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        logger.exception("Ingestion job failed.")
        raise
