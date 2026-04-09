# %% [markdown]
# # Claims Anomaly Detection - Model Comparison
#
# Comparing different approaches for detecting anomalous claims:
# 1. Isolation Forest (current production model)
# 2. Autoencoder (experimental)
# 3. LOF (Local Outlier Factor) - abandoned
# 4. One-Class SVM - abandoned (too slow)
# 5. DBSCAN clustering - abandoned (poor results)
#
# Author: @mrodriguez
# Date: 2025-09-01
# Updated: 2025-10-20

# %%
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
import seaborn as sns
from sklearn.ensemble import IsolationForest
from sklearn.neighbors import LocalOutlierFactor
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import precision_score, recall_score, f1_score

# plt.style.use("seaborn-v0_8-whitegrid")
plt.rcParams["figure.figsize"] = (12, 6)

# %%
# Load test data with known anomalies
# Using a pre-extracted dataset that has both clean and known-fraudulent claims
# claims = pd.read_parquet("/data/extracts/claims_with_labels_2024.parquet")
claims = pd.read_csv("/data/extracts/claims_sample_50k.csv")
known = pd.read_csv("../data/known_anomalies.csv")

print(f"Claims: {len(claims)}")
print(f"Known anomalies: {len(known)}")

# %%
# Build features
from src.features import build_anomaly_features
features = build_anomaly_features(claims)
print(f"Features shape: {features.shape}")

# Label known anomalies
claims["is_anomaly"] = claims["claim_id"].isin(known["claim_id"]).astype(int)
y_true = claims["is_anomaly"]

print(f"Anomaly rate: {y_true.mean():.4f}")
print(f"Known anomalies found: {y_true.sum()}")

# %%
# Scale features
scaler = StandardScaler()
X_scaled = scaler.fit_transform(features)

# %% [markdown]
# ## 1. Isolation Forest

# %%
iso_forest = IsolationForest(
    n_estimators=200,
    contamination=0.02,
    max_features=0.8,
    random_state=42,
    n_jobs=-1,
)
iso_forest.fit(X_scaled)

iso_scores = iso_forest.decision_function(X_scaled)
iso_preds = iso_forest.predict(X_scaled)
iso_anomaly = (iso_preds == -1).astype(int)

print("=== Isolation Forest ===")
print(f"Flagged: {iso_anomaly.sum()} ({iso_anomaly.mean()*100:.1f}%)")
print(f"Precision: {precision_score(y_true, iso_anomaly, zero_division=0):.3f}")
print(f"Recall: {recall_score(y_true, iso_anomaly, zero_division=0):.3f}")
print(f"F1: {f1_score(y_true, iso_anomaly, zero_division=0):.3f}")

# Results (2025-10-20 run):
# Flagged: 1000 (2.0%)
# Precision: 0.012
# Recall: 0.600
# F1: 0.024
#
# Low precision is expected - most flagged claims are not in our known set
# but they might still be real anomalies. SIU reviews confirm ~15% of
# flagged claims have issues (vs 2% baseline).

# %% [markdown]
# ## 2. Local Outlier Factor

# %%
# LOF - slower than IF but might catch different patterns
lof = LocalOutlierFactor(
    n_neighbors=20,
    contamination=0.02,
    metric="euclidean",
    n_jobs=-1,
)
lof_preds = lof.fit_predict(X_scaled)
lof_anomaly = (lof_preds == -1).astype(int)
lof_scores = lof.negative_outlier_factor_

print("=== Local Outlier Factor ===")
print(f"Flagged: {lof_anomaly.sum()} ({lof_anomaly.mean()*100:.1f}%)")
print(f"Precision: {precision_score(y_true, lof_anomaly, zero_division=0):.3f}")
print(f"Recall: {recall_score(y_true, lof_anomaly, zero_division=0):.3f}")
print(f"F1: {f1_score(y_true, lof_anomaly, zero_division=0):.3f}")

# Results:
# Flagged: 1000 (2.0%)
# Precision: 0.008
# Recall: 0.400
# F1: 0.016
#
# WORSE than Isolation Forest on our data.
# LOF is better for local density-based anomalies, but our fraud
# patterns are more global (extreme charges, impossible combos).
# ABANDONED.

# %% [markdown]
# ## 3. One-Class SVM

# %%
# One-Class SVM - tried but WAY too slow for production
# from sklearn.svm import OneClassSVM
# ocsvm = OneClassSVM(kernel="rbf", gamma="scale", nu=0.02)
# # This takes ~45 minutes on 50k claims... not viable for daily scoring of 500k+
# # ocsvm.fit(X_scaled)
# # ocsvm_preds = ocsvm.predict(X_scaled)

# Results from a previous run on 10k sample:
# Precision: 0.010
# Recall: 0.500
# F1: 0.020
# Similar to IF but 100x slower. ABANDONED.

# %% [markdown]
# ## 4. Autoencoder (Experimental)

# %%
# Autoencoder approach - learn normal patterns, flag high reconstruction error
# This SHOULD work better than IF for subtle multi-feature anomalies
# but I'm struggling to get good results

# import tensorflow as tf
# from tensorflow.keras import layers, Model
#
# # Build autoencoder
# input_dim = X_scaled.shape[1]
# encoding_dim = 16
#
# inputs = layers.Input(shape=(input_dim,))
# x = layers.Dense(64, activation="relu")(inputs)
# x = layers.Dropout(0.2)(x)
# x = layers.Dense(32, activation="relu")(x)
# encoded = layers.Dense(encoding_dim, activation="relu")(x)
# x = layers.Dense(32, activation="relu")(encoded)
# x = layers.Dense(64, activation="relu")(x)
# decoded = layers.Dense(input_dim, activation="linear")(x)
#
# autoencoder = Model(inputs, decoded)
# autoencoder.compile(optimizer="adam", loss="mse")
#
# # Train on all data (unsupervised)
# history = autoencoder.fit(
#     X_scaled, X_scaled,
#     epochs=50,
#     batch_size=256,
#     validation_split=0.1,
#     verbose=0,
# )

# %%
# Reconstruction error analysis
# reconstructed = autoencoder.predict(X_scaled)
# recon_error = np.mean((X_scaled - reconstructed) ** 2, axis=1)
#
# # Use 98th percentile as threshold (matching contamination=0.02)
# threshold = np.percentile(recon_error, 98)
# ae_anomaly = (recon_error > threshold).astype(int)
#
# print("=== Autoencoder ===")
# print(f"Flagged: {ae_anomaly.sum()} ({ae_anomaly.mean()*100:.1f}%)")
# print(f"Precision: {precision_score(y_true, ae_anomaly, zero_division=0):.3f}")
# print(f"Recall: {recall_score(y_true, ae_anomaly, zero_division=0):.3f}")
# print(f"F1: {f1_score(y_true, ae_anomaly, zero_division=0):.3f}")

# Results (when it worked):
# Precision: 0.006
# Recall: 0.350
# F1: 0.012
#
# WORSE than IF. The reconstruction error distribution is really messy -
# hard to set a clean threshold. The autoencoder seems to reconstruct
# anomalous claims just as well as normal ones.
#
# Hypotheses:
# 1. Not enough training data (50k might not be enough for AE)
# 2. Feature space is too heterogeneous (mix of charges, counts, ratios)
# 3. The AE architecture might not be right - maybe try VAE?
# 4. Maybe the anomalies aren't in the feature space we're looking at
#
# TODO: revisit with more data and try VAE approach

# %%
# Error distribution comparison (from previous run)
# fig, axes = plt.subplots(1, 2, figsize=(14, 5))
#
# axes[0].hist(recon_error[y_true == 0], bins=100, alpha=0.7, label="Normal", density=True)
# axes[0].hist(recon_error[y_true == 1], bins=20, alpha=0.7, label="Anomaly", density=True)
# axes[0].axvline(threshold, color="r", linestyle="--", label="Threshold")
# axes[0].set_xlabel("Reconstruction Error")
# axes[0].set_title("Autoencoder Reconstruction Error")
# axes[0].legend()
#
# axes[1].hist(iso_scores[y_true == 0], bins=100, alpha=0.7, label="Normal", density=True)
# axes[1].hist(iso_scores[y_true == 1], bins=20, alpha=0.7, label="Anomaly", density=True)
# axes[1].set_xlabel("Anomaly Score")
# axes[1].set_title("Isolation Forest Scores")
# axes[1].legend()
#
# plt.tight_layout()
# # The IF score distribution has much cleaner separation than AE.

# %% [markdown]
# ## 5. DBSCAN Clustering

# %%
# Tried DBSCAN to find clusters, treat small/outlier clusters as anomalies
# from sklearn.cluster import DBSCAN
#
# db = DBSCAN(eps=2.0, min_samples=10, metric="euclidean", n_jobs=-1)
# clusters = db.fit_predict(X_scaled)
#
# print(f"Clusters found: {len(set(clusters)) - 1}")  # -1 for noise label
# print(f"Noise points: {(clusters == -1).sum()}")
#
# # Results:
# # Clusters found: 3
# # Noise points: 8234
# #
# # Way too many noise points (16%!) and the clusters don't map to
# # meaningful anomaly patterns. The feature space is too high-dimensional
# # for DBSCAN. Would need dimensionality reduction first.
# # ABANDONED.

# %% [markdown]
# ## Comparison Summary

# %%
# Summary table from experiments
results = pd.DataFrame({
    "Model": ["Isolation Forest", "LOF", "One-Class SVM", "Autoencoder", "DBSCAN"],
    "Precision": [0.012, 0.008, 0.010, 0.006, None],
    "Recall": [0.600, 0.400, 0.500, 0.350, None],
    "F1": [0.024, 0.016, 0.020, 0.012, None],
    "Training Time": ["~30s", "~2min", "~45min", "~5min", "~1min"],
    "Inference Time (50k)": ["~1s", "~10s", "~5min", "~2s", "~30s"],
    "Status": ["PRODUCTION", "abandoned", "abandoned", "experimental", "abandoned"],
})
print(results.to_string(index=False))

# CONCLUSION:
# Isolation Forest is the clear winner for our use case:
# - Highest recall on known anomalies
# - Fastest training and inference
# - Simplest to maintain
#
# The autoencoder idea has potential but needs more work.
# For now, Isolation Forest + rules engine is our production approach.
#
# Next steps:
# 1. Try VAE instead of vanilla autoencoder
# 2. Get more labeled data from SIU reviews
# 3. Consider ensemble of IF + rules (already doing this in predict.py)
# 4. Feature engineering: add provider specialty, patient comorbidity data

# %%
# Contamination sensitivity analysis for IF
contamination_values = [0.005, 0.01, 0.02, 0.03, 0.05, 0.10]
results_by_contamination = []

for c in contamination_values:
    model = IsolationForest(n_estimators=200, contamination=c, random_state=42, n_jobs=-1)
    model.fit(X_scaled)
    preds = (model.predict(X_scaled) == -1).astype(int)
    r = {
        "contamination": c,
        "n_flagged": preds.sum(),
        "flag_rate": preds.mean(),
        "recall": recall_score(y_true, preds, zero_division=0),
        "precision": precision_score(y_true, preds, zero_division=0),
    }
    results_by_contamination.append(r)

cont_df = pd.DataFrame(results_by_contamination)
print("\nContamination sensitivity:")
print(cont_df.to_string(index=False))

# contamination=0.02 is the sweet spot
# Lower = misses too many anomalies
# Higher = too many false positives for SIU to review

# %%
print("Done with model comparison!")
