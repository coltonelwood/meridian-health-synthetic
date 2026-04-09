"""
Build FAISS similarity index from patient embeddings.

The index enables fast approximate nearest neighbor search
across the patient population.

Usage:
    python -m src.build_index \
        --data-dir /data/patient_features/ \
        --output-dir /opt/ml/indexes/ \
        --method pca

Author: @jpark
"""

import argparse
import json
import logging
import os
import pickle
import time
from datetime import datetime
from pathlib import Path

import faiss
import numpy as np
import pandas as pd

from src.features import build_patient_features
from src.embeddings import get_embedder

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

# Index parameters
# IVF = Inverted File Index - partitions space into nlist clusters
# PQ = Product Quantization - compresses vectors for memory efficiency
# For our patient population (~500k patients, 64-dim embeddings):
#   - IVF with 256 clusters + PQ works well
#   - Index size: ~50MB (vs ~130MB for flat index)
#   - Search time: ~2ms for top-10 (vs ~20ms for flat)
#   - Recall@10: ~0.95 (vs 1.0 for flat)

FAISS_INDEX_TYPE = "IVF256,PQ16"  # inverted file with product quantization
FAISS_NPROBE = 16  # number of clusters to search (higher = more accurate, slower)

# For smaller datasets (<50k), just use flat index (exact search)
FLAT_INDEX_THRESHOLD = 50000


def build_faiss_index(
    embeddings: np.ndarray,
    use_gpu: bool = False,
) -> faiss.Index:
    """Build a FAISS index from patient embeddings.

    Automatically selects flat vs IVF+PQ based on dataset size.
    """
    n, dim = embeddings.shape
    logger.info(f"Building FAISS index: {n} vectors, {dim} dimensions")

    # Ensure float32 and contiguous
    embeddings = np.ascontiguousarray(embeddings.astype(np.float32))

    if n < FLAT_INDEX_THRESHOLD:
        logger.info("Small dataset, using flat (exact) index")
        index = faiss.IndexFlatIP(dim)  # inner product (cosine sim after L2 norm)
        index.add(embeddings)
    else:
        logger.info(f"Large dataset, using {FAISS_INDEX_TYPE}")
        index = faiss.index_factory(dim, FAISS_INDEX_TYPE, faiss.METRIC_INNER_PRODUCT)

        # Train the index (needed for IVF and PQ)
        logger.info("Training index...")
        train_start = time.time()

        # Use a sample for training if dataset is very large
        if n > 100000:
            train_sample = embeddings[np.random.choice(n, 100000, replace=False)]
        else:
            train_sample = embeddings

        index.train(train_sample)
        logger.info(f"Training took {time.time() - train_start:.1f}s")

        # Add all vectors
        logger.info("Adding vectors to index...")
        index.add(embeddings)

        # Set search parameters
        faiss.ParameterSpace().set_index_parameter(index, "nprobe", FAISS_NPROBE)

    if use_gpu and faiss.get_num_gpus() > 0:
        logger.info("Moving index to GPU")
        res = faiss.StandardGpuResources()
        index = faiss.index_cpu_to_gpu(res, 0, index)

    logger.info(f"Index built: {index.ntotal} vectors, {index.d} dimensions")
    return index


# TODO: implement incremental index updates
# Right now we rebuild the entire index when new patients are added.
# This takes ~10 minutes for 500k patients and happens nightly.
# FAISS supports add() for flat indexes, but IVF+PQ needs retraining
# after significant distribution shifts.
#
# Options:
# 1. Just use flat index (slower search but supports add())
# 2. Rebuild nightly (current approach, works but wasteful)
# 3. Use IVF with add() but retrain weekly
# 4. Switch to Annoy (supports incremental, but slower)
#
# For now option 2 is fine. Revisit when we hit performance issues.


def main():
    parser = argparse.ArgumentParser(description="Build patient similarity index")
    parser.add_argument("--patients-path", required=True, help="Path to patients data")
    parser.add_argument("--diagnoses-path", required=True)
    parser.add_argument("--medications-path", required=True)
    parser.add_argument("--labs-path", required=True)
    parser.add_argument("--procedures-path", required=True)
    parser.add_argument("--output-dir", default="/opt/ml/indexes")
    parser.add_argument("--embedding-method", default="pca", choices=["pca", "autoencoder"])
    parser.add_argument("--use-gpu", action="store_true")
    args = parser.parse_args()

    # Load data
    logger.info("Loading patient data...")
    patients_df = pd.read_parquet(args.patients_path)
    diagnoses_df = pd.read_parquet(args.diagnoses_path)
    medications_df = pd.read_parquet(args.medications_path)
    labs_df = pd.read_parquet(args.labs_path)
    procedures_df = pd.read_parquet(args.procedures_path)

    logger.info(f"Patients: {len(patients_df)}")

    # Build features
    features = build_patient_features(
        patients_df, diagnoses_df, medications_df, labs_df, procedures_df
    )

    # Generate embeddings
    embedder = get_embedder(args.embedding_method)
    embeddings = embedder.fit_transform(features)

    # Build FAISS index
    index = build_faiss_index(embeddings, use_gpu=args.use_gpu)

    # Save artifacts
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    # Save index
    index_path = output_dir / f"patient_similarity_{timestamp}.faiss"
    faiss.write_index(
        faiss.index_gpu_to_cpu(index) if hasattr(index, "getDevice") else index,
        str(index_path),
    )
    logger.info(f"Index saved to {index_path}")

    # Save patient ID mapping (index position -> patient_id)
    mapping_path = output_dir / f"patient_mapping_{timestamp}.json"
    mapping = {
        "patient_ids": patients_df["patient_id"].tolist(),
        "n_patients": len(patients_df),
        "embedding_dim": embeddings.shape[1],
        "embedding_method": args.embedding_method,
        "index_type": FAISS_INDEX_TYPE if len(patients_df) >= FLAT_INDEX_THRESHOLD else "Flat",
        "created_at": timestamp,
    }
    with open(mapping_path, "w") as f:
        json.dump(mapping, f)

    # Save embedder (needed for query-time embedding of new patients)
    embedder_path = output_dir / f"embedder_{timestamp}.pkl"
    with open(embedder_path, "wb") as f:
        pickle.dump(embedder, f)

    # Save a symlink to latest
    latest_index = output_dir / "latest.faiss"
    latest_mapping = output_dir / "latest_mapping.json"
    latest_embedder = output_dir / "latest_embedder.pkl"
    for latest, target in [
        (latest_index, index_path),
        (latest_mapping, mapping_path),
        (latest_embedder, embedder_path),
    ]:
        if latest.exists():
            latest.unlink()
        latest.symlink_to(target.name)

    logger.info("Index build complete!")
    logger.info(f"  Index: {index_path} ({index_path.stat().st_size / 1024 / 1024:.1f}MB)")
    logger.info(f"  Mapping: {mapping_path}")
    logger.info(f"  Embedder: {embedder_path}")


if __name__ == "__main__":
    main()
