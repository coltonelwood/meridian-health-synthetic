"""
Query interface for patient similarity search.

Given a patient, find the K most similar patients from the index.
Used by:
- Clinical decision support (find similar cases)
- Cohort discovery for research
- Care gap identification (what happened to similar patients?)

Author: @jpark
"""

import json
import logging
import os
import pickle
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import faiss
import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

# Default paths
INDEX_DIR = os.environ.get("SIMILARITY_INDEX_DIR", "/opt/ml/indexes")
DEFAULT_K = 10  # return top 10 similar patients

# Minimum similarity threshold
# Below this, results are probably not clinically meaningful
MIN_SIMILARITY = 0.3  # cosine similarity, range [0, 1] for L2-normalized vectors


class PatientSimilarityQuery:
    """Query engine for patient similarity search."""

    def __init__(self, index_dir: str = None):
        self.index_dir = Path(index_dir or INDEX_DIR)
        self.index = None
        self.patient_ids = None
        self.embedder = None
        self.metadata = None
        self._load_artifacts()

    def _load_artifacts(self):
        """Load index, mapping, and embedder."""
        # Try loading "latest" symlinks first, then find most recent files
        index_path = self.index_dir / "latest.faiss"
        mapping_path = self.index_dir / "latest_mapping.json"
        embedder_path = self.index_dir / "latest_embedder.pkl"

        if not index_path.exists():
            # Find most recent files
            faiss_files = sorted(self.index_dir.glob("patient_similarity_*.faiss"))
            if not faiss_files:
                raise FileNotFoundError(f"No index files found in {self.index_dir}")
            index_path = faiss_files[-1]
            mapping_path = self.index_dir / index_path.name.replace(
                "patient_similarity_", "patient_mapping_"
            ).replace(".faiss", ".json")
            embedder_path = self.index_dir / index_path.name.replace(
                "patient_similarity_", "embedder_"
            ).replace(".faiss", ".pkl")

        # Load FAISS index
        logger.info(f"Loading index from {index_path}")
        self.index = faiss.read_index(str(index_path))
        logger.info(f"Index loaded: {self.index.ntotal} vectors")

        # Load patient ID mapping
        with open(mapping_path) as f:
            self.metadata = json.load(f)
        self.patient_ids = self.metadata["patient_ids"]

        # Load embedder
        with open(embedder_path, "rb") as f:
            self.embedder = pickle.load(f)

        logger.info(f"Loaded similarity engine: {len(self.patient_ids)} patients")

    def find_similar(
        self,
        patient_features: np.ndarray,
        k: int = DEFAULT_K,
        min_similarity: float = MIN_SIMILARITY,
        exclude_patient_ids: Optional[List[str]] = None,
    ) -> List[Dict]:
        """Find K most similar patients.

        Args:
            patient_features: Feature vector for the query patient
                (raw features, will be embedded)
            k: Number of similar patients to return
            min_similarity: Minimum cosine similarity threshold
            exclude_patient_ids: Patient IDs to exclude from results
                (e.g., the query patient themselves)

        Returns:
            List of dicts with patient_id, similarity_score, rank
        """
        # Embed the query patient
        if patient_features.ndim == 1:
            patient_features = patient_features.reshape(1, -1)

        embedding = self.embedder.transform(patient_features)
        embedding = np.ascontiguousarray(embedding.astype(np.float32))

        # Search (request extra results in case we need to filter)
        search_k = k + len(exclude_patient_ids or []) + 5
        scores, indices = self.index.search(embedding, search_k)

        # Build results
        results = []
        for score, idx in zip(scores[0], indices[0]):
            if idx < 0:  # FAISS returns -1 for missing results
                continue
            if score < min_similarity:
                continue

            patient_id = self.patient_ids[idx]

            if exclude_patient_ids and patient_id in exclude_patient_ids:
                continue

            results.append({
                "patient_id": patient_id,
                "similarity_score": float(score),
                "rank": len(results) + 1,
            })

            if len(results) >= k:
                break

        return results

    def find_similar_by_id(
        self,
        patient_id: str,
        k: int = DEFAULT_K,
        min_similarity: float = MIN_SIMILARITY,
    ) -> List[Dict]:
        """Find similar patients given a patient ID.

        Looks up the patient's embedding from the index directly,
        so no feature computation needed.
        """
        if patient_id not in self.patient_ids:
            raise ValueError(f"Patient {patient_id} not found in index")

        idx = self.patient_ids.index(patient_id)

        # Reconstruct the embedding from the index
        embedding = np.zeros((1, self.index.d), dtype=np.float32)
        self.index.reconstruct(idx, embedding[0])  # in-place

        # Search
        search_k = k + 5
        scores, indices = self.index.search(embedding, search_k)

        results = []
        for score, match_idx in zip(scores[0], indices[0]):
            if match_idx < 0:
                continue
            match_id = self.patient_ids[match_idx]
            if match_id == patient_id:
                continue  # exclude self
            if score < min_similarity:
                continue

            results.append({
                "patient_id": match_id,
                "similarity_score": float(score),
                "rank": len(results) + 1,
            })

            if len(results) >= k:
                break

        return results

    def batch_find_similar(
        self,
        patient_ids: List[str],
        k: int = DEFAULT_K,
    ) -> Dict[str, List[Dict]]:
        """Find similar patients for a batch of patients.

        More efficient than calling find_similar_by_id in a loop
        because we batch the FAISS search.
        """
        # Build query matrix
        indices = []
        valid_ids = []
        for pid in patient_ids:
            if pid in self.patient_ids:
                indices.append(self.patient_ids.index(pid))
                valid_ids.append(pid)
            else:
                logger.warning(f"Patient {pid} not in index, skipping")

        if not indices:
            return {}

        # Reconstruct embeddings
        embeddings = np.zeros((len(indices), self.index.d), dtype=np.float32)
        for i, idx in enumerate(indices):
            self.index.reconstruct(idx, embeddings[i])

        # Batch search
        scores, match_indices = self.index.search(embeddings, k + 5)

        # Build results
        results = {}
        for i, pid in enumerate(valid_ids):
            patient_results = []
            for score, match_idx in zip(scores[i], match_indices[i]):
                if match_idx < 0:
                    continue
                match_id = self.patient_ids[match_idx]
                if match_id == pid:
                    continue

                patient_results.append({
                    "patient_id": match_id,
                    "similarity_score": float(score),
                    "rank": len(patient_results) + 1,
                })

                if len(patient_results) >= k:
                    break

            results[pid] = patient_results

        return results


# Singleton
_query_engine = None


def get_query_engine(index_dir: str = None) -> PatientSimilarityQuery:
    global _query_engine
    if _query_engine is None:
        _query_engine = PatientSimilarityQuery(index_dir)
    return _query_engine
