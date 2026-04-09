"""
Patient embedding generation.

Two approaches:
1. PCA - fast, simple, production-ready
2. Autoencoder - experimental, potentially better

The embeddings reduce the high-dimensional patient feature vectors
to a lower-dimensional space suitable for similarity search.

Author: @achen
"""

import logging
from typing import Optional, Tuple

import numpy as np
from sklearn.decomposition import PCA
from sklearn.preprocessing import StandardScaler

logger = logging.getLogger(__name__)

# PCA parameters
PCA_N_COMPONENTS = 64  # reduces ~700 features to 64 dims
PCA_VARIANCE_TARGET = 0.90  # alternatively, keep components explaining 90% variance

# Autoencoder parameters (experimental)
AE_ENCODING_DIM = 64
AE_HIDDEN_LAYERS = [256, 128]
AE_EPOCHS = 100
AE_BATCH_SIZE = 512
AE_LEARNING_RATE = 0.001


class PCAEmbedder:
    """Generate patient embeddings using PCA.

    This is our production approach. Simple, fast, interpretable.
    Captures ~90% of variance in 64 dimensions.
    """

    def __init__(self, n_components: int = PCA_N_COMPONENTS):
        self.n_components = n_components
        self.scaler = StandardScaler()
        self.pca = PCA(n_components=n_components)
        self.is_fitted = False

    def fit(self, features: np.ndarray) -> "PCAEmbedder":
        """Fit PCA on patient features."""
        logger.info(f"Fitting PCA: {features.shape} -> {self.n_components} dims")

        # Scale first
        X_scaled = self.scaler.fit_transform(features)

        # Fit PCA
        self.pca.fit(X_scaled)

        explained = self.pca.explained_variance_ratio_.sum()
        logger.info(f"Explained variance: {explained:.3f} with {self.n_components} components")

        self.is_fitted = True
        return self

    def transform(self, features: np.ndarray) -> np.ndarray:
        """Generate embeddings for patient features."""
        if not self.is_fitted:
            raise RuntimeError("PCA not fitted. Call fit() first.")

        X_scaled = self.scaler.transform(features)
        embeddings = self.pca.transform(X_scaled)

        # L2 normalize so cosine similarity = dot product
        norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
        norms = np.clip(norms, 1e-10, None)  # avoid div by zero
        embeddings = embeddings / norms

        return embeddings.astype(np.float32)

    def fit_transform(self, features: np.ndarray) -> np.ndarray:
        """Fit and transform in one step."""
        self.fit(features)
        return self.transform(features)


class AutoencoderEmbedder:
    """Generate patient embeddings using an autoencoder.

    EXPERIMENTAL - not yet validated for production use.

    The idea is that the autoencoder bottleneck learns a more
    meaningful representation than PCA because it can capture
    non-linear relationships between features.

    Status: Mixed results. Sometimes better than PCA on clinical
    similarity benchmarks, sometimes worse. Very sensitive to
    hyperparameters and training data size.
    """

    def __init__(
        self,
        encoding_dim: int = AE_ENCODING_DIM,
        hidden_layers: list = None,
    ):
        self.encoding_dim = encoding_dim
        self.hidden_layers = hidden_layers or AE_HIDDEN_LAYERS
        self.scaler = StandardScaler()
        self.model = None
        self.encoder = None
        self.is_fitted = False

    def _build_model(self, input_dim: int):
        """Build autoencoder model."""
        import torch
        import torch.nn as nn

        layers = []
        prev_dim = input_dim

        # Encoder
        for hidden_dim in self.hidden_layers:
            layers.append(nn.Linear(prev_dim, hidden_dim))
            layers.append(nn.ReLU())
            layers.append(nn.BatchNorm1d(hidden_dim))
            layers.append(nn.Dropout(0.2))
            prev_dim = hidden_dim

        # Bottleneck
        layers.append(nn.Linear(prev_dim, self.encoding_dim))
        layers.append(nn.ReLU())

        encoder = nn.Sequential(*layers)

        # Decoder
        decoder_layers = []
        prev_dim = self.encoding_dim
        for hidden_dim in reversed(self.hidden_layers):
            decoder_layers.append(nn.Linear(prev_dim, hidden_dim))
            decoder_layers.append(nn.ReLU())
            decoder_layers.append(nn.BatchNorm1d(hidden_dim))
            prev_dim = hidden_dim

        decoder_layers.append(nn.Linear(prev_dim, input_dim))
        decoder = nn.Sequential(*decoder_layers)

        class Autoencoder(nn.Module):
            def __init__(self, enc, dec):
                super().__init__()
                self.encoder = enc
                self.decoder = dec

            def forward(self, x):
                z = self.encoder(x)
                x_hat = self.decoder(z)
                return x_hat

            def encode(self, x):
                return self.encoder(x)

        return Autoencoder(encoder, decoder)

    def fit(self, features: np.ndarray) -> "AutoencoderEmbedder":
        """Train autoencoder on patient features."""
        import torch
        from torch.utils.data import DataLoader, TensorDataset

        logger.info(f"Training autoencoder: {features.shape} -> {self.encoding_dim} dims")

        # Scale
        X_scaled = self.scaler.fit_transform(features).astype(np.float32)
        X_tensor = torch.tensor(X_scaled)

        # Build model
        self.model = self._build_model(features.shape[1])
        device = "cuda" if torch.cuda.is_available() else "cpu"
        self.model = self.model.to(device)

        # Training
        optimizer = torch.optim.Adam(self.model.parameters(), lr=AE_LEARNING_RATE)
        criterion = torch.nn.MSELoss()

        dataset = TensorDataset(X_tensor, X_tensor)
        loader = DataLoader(dataset, batch_size=AE_BATCH_SIZE, shuffle=True)

        self.model.train()
        for epoch in range(AE_EPOCHS):
            total_loss = 0
            n_batches = 0
            for batch_x, batch_y in loader:
                batch_x = batch_x.to(device)

                optimizer.zero_grad()
                output = self.model(batch_x)
                loss = criterion(output, batch_x)
                loss.backward()
                optimizer.step()

                total_loss += loss.item()
                n_batches += 1

            if (epoch + 1) % 10 == 0:
                avg_loss = total_loss / n_batches
                logger.info(f"  Epoch {epoch+1}/{AE_EPOCHS}, Loss: {avg_loss:.6f}")

        self.is_fitted = True
        logger.info("Autoencoder training complete")
        return self

    def transform(self, features: np.ndarray) -> np.ndarray:
        """Generate embeddings using the encoder."""
        import torch

        if not self.is_fitted:
            raise RuntimeError("Autoencoder not fitted. Call fit() first.")

        X_scaled = self.scaler.transform(features).astype(np.float32)
        X_tensor = torch.tensor(X_scaled)

        device = next(self.model.parameters()).device
        X_tensor = X_tensor.to(device)

        self.model.eval()
        with torch.no_grad():
            embeddings = self.model.encode(X_tensor).cpu().numpy()

        # L2 normalize
        norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
        norms = np.clip(norms, 1e-10, None)
        embeddings = embeddings / norms

        return embeddings.astype(np.float32)

    def fit_transform(self, features: np.ndarray) -> np.ndarray:
        self.fit(features)
        return self.transform(features)


def get_embedder(method: str = "pca", **kwargs):
    """Factory for embedding method selection.

    Args:
        method: "pca" (production) or "autoencoder" (experimental)
    """
    if method == "pca":
        return PCAEmbedder(**kwargs)
    elif method == "autoencoder":
        return AutoencoderEmbedder(**kwargs)
    else:
        raise ValueError(f"Unknown embedding method: {method}. Use 'pca' or 'autoencoder'.")
