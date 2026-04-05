import logging
import math
from typing import Dict, Iterator, List, Optional, Tuple

import osmnx as ox
from psycopg2.extras import execute_values
from shapely.geometry import Point
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine

from database import DATABASE_URL, POINode


PLACE_NAME = "Bengaluru, Karnataka, India"
BATCH_SIZE = 10_000
POI_TAGS = {
    "amenity": [
        "bar",
        "pub",
        "nightclub",
        "cafe",
        "restaurant",
        "police",
        "hospital",
        "pharmacy",
    ]
}
ELEMENT_TYPE_OFFSETS = {
    "node": 1_000_000_000_000_000,
    "way": 2_000_000_000_000_000,
    "relation": 3_000_000_000_000_000,
}


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)


def chunked(items: List[Tuple[int, str, str]], size: int) -> Iterator[List[Tuple[int, str, str]]]:
    for start in range(0, len(items), size):
        yield items[start : start + size]


def normalize_osm_id(element_type: str, osm_id: int) -> int:
    offset = ELEMENT_TYPE_OFFSETS.get(str(element_type).lower(), 9_000_000_000_000_000)
    return offset + int(osm_id)


def to_point_geometry(geometry) -> Optional[Point]:
    if geometry is None or geometry.is_empty:
        return None

    if geometry.geom_type == "Point":
        return geometry

    if geometry.geom_type in {"Polygon", "MultiPolygon", "LineString", "MultiLineString"}:
        centroid = geometry.centroid
        if centroid.is_empty:
            return None
        return centroid

    return None


def extract_poi_rows() -> List[Tuple[int, str, str]]:
    logger.info("Downloading POIs for %s...", PLACE_NAME)
    features = ox.features_from_place(PLACE_NAME, tags=POI_TAGS)
    logger.info("Downloaded %s raw feature(s).", len(features))

    rows: List[Tuple[int, str, str]] = []
    skipped = 0

    for index, feature in enumerate(features.itertuples(), start=1):
        amenity_type = getattr(feature, "amenity", None)
        geometry = getattr(feature, "geometry", None)

        if not amenity_type:
            skipped += 1
            continue

        point_geometry = to_point_geometry(geometry)
        if point_geometry is None:
            skipped += 1
            continue

        try:
            element_type = feature.Index[0]
            osm_id = feature.Index[1]
            poi_id = normalize_osm_id(element_type, osm_id)
        except Exception:
            skipped += 1
            logger.warning("Skipping feature %s because its OSM identifier could not be parsed.", feature.Index)
            continue

        rows.append((poi_id, str(amenity_type), point_geometry.wkt))

        if index % 5_000 == 0 or index == len(features):
            logger.info(
                "Prepared %s/%s POIs for insertion. Skipped so far: %s.",
                index,
                len(features),
                skipped,
            )

    logger.info("POI extraction complete. Prepared %s row(s), skipped %s.", len(rows), skipped)
    return rows


def ensure_poi_table(engine: Engine) -> None:
    logger.info("Ensuring POI table exists...")
    POINode.__table__.create(bind=engine, checkfirst=True)
    with engine.begin() as connection:
        connection.execute(
            text(
                """
                TRUNCATE TABLE poi_nodes
                """
            )
        )
    logger.info("POI table ready and cleared for fresh ingestion.")


def insert_poi_rows(engine: Engine, rows: List[Tuple[int, str, str]]) -> None:
    if not rows:
        logger.warning("No POIs were prepared. Skipping insert.")
        return

    total_batches = math.ceil(len(rows) / BATCH_SIZE)
    logger.info("Starting POI insert across %s batch(es)...", total_batches)

    connection = engine.raw_connection()
    try:
        with connection.cursor() as cursor:
            for batch_number, batch in enumerate(chunked(rows, BATCH_SIZE), start=1):
                logger.info("Inserting batch %s/%s with %s row(s)...", batch_number, total_batches, len(batch))
                execute_values(
                    cursor,
                    """
                    INSERT INTO poi_nodes (id, amenity_type, geometry)
                    VALUES %s
                    """,
                    batch,
                    template="(%s, %s, ST_GeomFromText(%s, 4326))",
                    page_size=BATCH_SIZE,
                )
                connection.commit()
                logger.info("Finished batch %s/%s.", batch_number, total_batches)
    except Exception:
        connection.rollback()
        logger.exception("POI insertion failed.")
        raise
    finally:
        connection.close()


def apply_spatial_join(engine: Engine) -> None:
    logger.info("Creating spatial indexes before offline spatial join...")
    with engine.begin() as connection:
        connection.execute(
            text(
                """
                CREATE INDEX IF NOT EXISTS idx_street_edges_geom
                ON street_edges
                USING GIST (geometry)
                """
            )
        )
        connection.execute(
            text(
                """
                CREATE INDEX IF NOT EXISTS idx_poi_nodes_geom
                ON poi_nodes
                USING GIST (geometry)
                """
            )
        )
        connection.execute(
            text(
                """
                CREATE INDEX IF NOT EXISTS idx_street_edges_geog
                ON street_edges
                USING GIST ((geometry::geography))
                """
            )
        )
        connection.execute(
            text(
                """
                CREATE INDEX IF NOT EXISTS idx_poi_nodes_geog
                ON poi_nodes
                USING GIST ((geometry::geography))
                """
            )
        )
    logger.info("Spatial indexes are ready. Running offline spatial join to enrich street edge safety scores...")

    with engine.begin() as connection:
        connection.execute(
            text(
                """
                WITH poi_counts AS (
                    SELECT
                        se.id AS street_edge_id,
                        COUNT(pn.id) AS poi_count,
                        COUNT(*) FILTER (WHERE pn.amenity_type = 'police') AS police_count
                    FROM street_edges AS se
                    LEFT JOIN poi_nodes AS pn
                      ON ST_DWithin(
                            se.geometry::geography,
                            pn.geometry::geography,
                            400
                         )
                    GROUP BY se.id
                )
                UPDATE street_edges AS se
                SET base_safety_score = LEAST(
                    100,
                    50 + (pc.poi_count * 5) + (pc.police_count * 20)
                )
                FROM poi_counts AS pc
                WHERE se.id = pc.street_edge_id
                """
            )
        )
    logger.info("Spatial join complete. Street edge safety scores refreshed.")


def main() -> None:
    logger.info("Creating database engine...")
    engine = create_engine(DATABASE_URL)

    ensure_poi_table(engine)
    rows = extract_poi_rows()
    insert_poi_rows(engine, rows)
    apply_spatial_join(engine)
    logger.info("POI ingestion and enrichment complete.")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        logger.exception("POI ingestion job failed.")
        raise
