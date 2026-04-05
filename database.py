from sqlalchemy import BigInteger, Column, Integer, String, create_engine
from sqlalchemy.orm import declarative_base, sessionmaker
from geoalchemy2 import Geometry


DATABASE_URL = "postgresql+psycopg2://postgres:postgres@localhost:5432/night_navigator"

Base = declarative_base()


class StreetEdge(Base):
    __tablename__ = "street_edges"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    start_node = Column(BigInteger, nullable=False, index=True)
    end_node = Column(BigInteger, nullable=False, index=True)
    geometry = Column(Geometry(geometry_type="LINESTRING", srid=4326), nullable=False)
    base_safety_score = Column(Integer, nullable=False, default=0)


class POINode(Base):
    __tablename__ = "poi_nodes"

    id = Column(BigInteger, primary_key=True)
    amenity_type = Column(String, nullable=False, index=True)
    geometry = Column(Geometry(geometry_type="POINT", srid=4326), nullable=False)


engine = create_engine(DATABASE_URL, echo=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


def init_db() -> None:
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)


if __name__ == "__main__":
    init_db()
    print("Database tables created successfully.")
