# %% [markdown]
# # Readmission Model - Exploratory Data Analysis
#
# Initial exploration of admission data for 30-day readmission prediction.
# Looking at feature distributions, correlations, and potential predictors.
#
# Author: @jpark
# Date: 2025-07-15
# Updated: 2025-09-22

# %%
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
import seaborn as sns
from pathlib import Path

# %matplotlib inline
plt.style.use("seaborn-v0_8-whitegrid")
sns.set_palette("Set2")

# %% [markdown]
# ## Load Data

# %%
# For notebook development, using a local parquet extract
# In production this comes from the data_loader module
DATA_PATH = "/data/extracts/admissions_2023_2024.parquet"
# df = pd.read_parquet(DATA_PATH)
# print(f"Loaded {len(df)} admissions")
# print(f"Date range: {df['discharge_date'].min()} to {df['discharge_date'].max()}")

# For now using a smaller CSV sample since I don't have the full extract on my laptop
df = pd.read_csv("/data/extracts/admissions_sample_10k.csv", parse_dates=["admit_date", "discharge_date", "date_of_birth"])
print(f"Sample: {len(df)} admissions")

# %%
df.head()

# %%
df.info()

# %% [markdown]
# ## Target Variable

# %%
print(f"Readmission rate: {df['readmitted_30d'].mean():.3f}")
print(f"\nClass distribution:")
print(df["readmitted_30d"].value_counts())

# FINDING: ~22% readmission rate. This is higher than national average (~15%)
# probably because our patient population skews sicker (academic medical center)

# %%
# Readmission rate over time
monthly = df.groupby(pd.Grouper(key="discharge_date", freq="M")).agg(
    n_admissions=("readmitted_30d", "count"),
    readmit_rate=("readmitted_30d", "mean"),
).reset_index()

fig, ax1 = plt.subplots(figsize=(12, 5))
ax2 = ax1.twinx()
ax1.bar(monthly["discharge_date"], monthly["n_admissions"], alpha=0.3, label="Volume")
ax2.plot(monthly["discharge_date"], monthly["readmit_rate"], "r-o", label="Readmit Rate")
ax1.set_xlabel("Discharge Month")
ax1.set_ylabel("Admission Volume")
ax2.set_ylabel("Readmission Rate")
ax2.set_ylim(0, 0.4)
plt.title("Monthly Readmission Rate and Volume")
fig.legend(loc="upper right", bbox_to_anchor=(0.9, 0.9))
plt.tight_layout()
plt.savefig("plots/readmit_trend.png", dpi=150)
# plt.show()

# FINDING: readmission rate is relatively stable over time (good - no major drift)
# Slight uptick in winter months (respiratory readmissions?)

# %% [markdown]
# ## Feature Distributions

# %%
# Age distribution
df["age"] = (pd.to_datetime(df["admit_date"]) - pd.to_datetime(df["date_of_birth"])).dt.days / 365.25

fig, axes = plt.subplots(1, 2, figsize=(14, 5))

axes[0].hist(df.loc[df["readmitted_30d"] == 0, "age"], bins=40, alpha=0.5, label="Not readmitted", density=True)
axes[0].hist(df.loc[df["readmitted_30d"] == 1, "age"], bins=40, alpha=0.5, label="Readmitted", density=True)
axes[0].set_xlabel("Age")
axes[0].set_ylabel("Density")
axes[0].legend()
axes[0].set_title("Age Distribution by Readmission Status")

# Age vs readmission rate
age_bins = pd.cut(df["age"], bins=[0, 30, 45, 55, 65, 75, 85, 120])
readmit_by_age = df.groupby(age_bins)["readmitted_30d"].mean()
readmit_by_age.plot(kind="bar", ax=axes[1])
axes[1].set_xlabel("Age Group")
axes[1].set_ylabel("Readmission Rate")
axes[1].set_title("Readmission Rate by Age Group")
axes[1].tick_params(axis="x", rotation=45)

plt.tight_layout()
# plt.savefig("plots/age_dist.png", dpi=150)

# FINDING: readmission rate increases with age, as expected
# Biggest jump is 65-75 -> 75-85 age group
# Interestingly, 85+ has slightly lower rate - survivorship bias?
# Or maybe they're more likely to go to SNF instead of home

# %%
# Length of stay
fig, axes = plt.subplots(1, 2, figsize=(14, 5))

# raw LOS (very skewed)
axes[0].hist(df["los_days"], bins=50, alpha=0.7)
axes[0].set_xlabel("Length of Stay (days)")
axes[0].set_title("LOS Distribution (raw)")
axes[0].axvline(df["los_days"].median(), color="r", linestyle="--", label=f"median={df['los_days'].median():.0f}")
axes[0].legend()

# log-transformed
axes[1].hist(np.log1p(df["los_days"]), bins=50, alpha=0.7)
axes[1].set_xlabel("Log(1 + LOS)")
axes[1].set_title("LOS Distribution (log-transformed)")

plt.tight_layout()

# FINDING: LOS is highly right-skewed. Median is ~4 days, but long tail to 60+
# Log transform helps a lot. Will use both raw and log in model.

# %%
# LOS vs readmission
los_bins = pd.cut(df["los_days"], bins=[0, 2, 4, 7, 14, 30, 100])
readmit_by_los = df.groupby(los_bins)["readmitted_30d"].mean()

fig, ax = plt.subplots(figsize=(8, 5))
readmit_by_los.plot(kind="bar", ax=ax)
ax.set_xlabel("Length of Stay (days)")
ax.set_ylabel("Readmission Rate")
ax.set_title("Readmission Rate by LOS")
ax.tick_params(axis="x", rotation=45)
plt.tight_layout()

# FINDING: U-shaped relationship. Very short stays (0-2 days) have higher
# readmission rate - possibly premature discharge.
# Very long stays (14+ days) also higher - sicker patients.
# Sweet spot is 4-7 days.

# %%
# Insurance type
insurance_counts = df.groupby("primary_insurance_type").agg(
    n=("readmitted_30d", "count"),
    readmit_rate=("readmitted_30d", "mean"),
).sort_values("readmit_rate", ascending=False)

print(insurance_counts)

# FINDING: Medicaid has highest readmission rate (28%), followed by Medicare (24%)
# Commercial is lowest (16%). This likely reflects social determinants
# and disease burden rather than insurance type per se.
# We include insurance in the model because it's a proxy for SDoH,
# but we should be careful about how this is used clinically.

# %%
# Discharge disposition
dispo_rates = df.groupby("discharge_disposition").agg(
    n=("readmitted_30d", "count"),
    readmit_rate=("readmitted_30d", "mean"),
).sort_values("readmit_rate", ascending=False)

print(dispo_rates)

# FINDING: home with home health has highest rate (27%)
# home without services is 21%
# This makes sense - patients needing home health are sicker

# %%
# Prior admissions
fig, ax = plt.subplots(figsize=(8, 5))
prior_bins = pd.cut(df["prior_admissions_6mo"].fillna(0), bins=[-1, 0, 1, 2, 3, 100])
readmit_by_prior = df.groupby(prior_bins)["readmitted_30d"].mean()
readmit_by_prior.plot(kind="bar", ax=ax)
ax.set_xlabel("Prior Admissions (6 months)")
ax.set_ylabel("Readmission Rate")
ax.set_title("Readmission Rate by Prior Utilization")
ax.tick_params(axis="x", rotation=45)
plt.tight_layout()

# FINDING: strong predictor! 0 prior admissions -> 18% readmit rate
# 3+ prior admissions -> 42% readmit rate
# This is the single strongest feature.

# %% [markdown]
# ## Correlations

# %%
# Correlation matrix for numeric features
numeric_cols = ["age", "los_days", "prior_admissions_6mo", "prior_admissions_all",
                "comorbidity_score", "n_diagnoses", "readmitted_30d"]
available_cols = [c for c in numeric_cols if c in df.columns]

corr_matrix = df[available_cols].corr()

fig, ax = plt.subplots(figsize=(10, 8))
sns.heatmap(corr_matrix, annot=True, fmt=".2f", cmap="coolwarm", center=0, ax=ax)
ax.set_title("Feature Correlations")
plt.tight_layout()

# FINDING: prior_admissions_6mo has highest correlation with readmission (0.23)
# comorbidity_score and los_days are moderately correlated (0.35) - makes sense
# No concerning multicollinearity between features

# %%
# Mutual information for non-linear relationships
# from sklearn.feature_selection import mutual_info_classif
# mi_scores = mutual_info_classif(
#     df[["age", "los_days", "prior_admissions_6mo", "comorbidity_score"]].fillna(0),
#     df["readmitted_30d"],
#     random_state=42,
# )
# print("Mutual Information Scores:")
# for feat, score in zip(["age", "los_days", "prior_admissions_6mo", "comorbidity_score"], mi_scores):
#     print(f"  {feat}: {score:.4f}")

# Results from a previous run:
# age: 0.0089
# los_days: 0.0142
# prior_admissions_6mo: 0.0287
# comorbidity_score: 0.0134

# %% [markdown]
# ## DRG Analysis

# %%
# Top DRGs by readmission rate (min 50 admissions)
drg_stats = df.groupby("drg_code").agg(
    n=("readmitted_30d", "count"),
    readmit_rate=("readmitted_30d", "mean"),
).query("n >= 50").sort_values("readmit_rate", ascending=False)

print("Top 15 DRGs by readmission rate:")
print(drg_stats.head(15))

# FINDING: Heart failure DRGs (291, 292, 293) dominate the top of the list
# Sepsis (871, 872) also high
# These match the literature well

# %%
# Number of unique DRGs
print(f"Unique DRGs: {df['drg_code'].nunique()}")
print(f"DRGs with >= 50 admissions: {len(drg_stats)}")

# Too many DRGs to use directly as a categorical feature (700+)
# Will use is_high_risk_drg binary flag + maybe DRG grouper (MDC)

# %% [markdown]
# ## Weekend Discharge Effect

# %%
df["discharge_dow"] = pd.to_datetime(df["discharge_date"]).dt.dayofweek
df["discharged_weekend"] = df["discharge_dow"].isin([5, 6]).astype(int)

print(f"Weekend discharge readmit rate: {df.loc[df['discharged_weekend']==1, 'readmitted_30d'].mean():.3f}")
print(f"Weekday discharge readmit rate: {df.loc[df['discharged_weekend']==0, 'readmitted_30d'].mean():.3f}")

# FINDING: Weekend discharge has slightly higher readmission rate (24% vs 21%)
# Consistent with literature - fewer follow-up resources available
# Small effect but worth including

# %% [markdown]
# ## Missing Data

# %%
missing = df.isnull().sum()
missing_pct = (missing / len(df) * 100).round(1)
missing_df = pd.DataFrame({"count": missing, "pct": missing_pct})
print(missing_df[missing_df["count"] > 0].sort_values("pct", ascending=False))

# FINDING: prior_admissions columns have some missingness (~5%)
# These are patients with no prior history in our system
# Will fill with 0 (reasonable assumption)
#
# comorbidity columns also have ~3% missing
# These are encounters with no diagnosis codes loaded yet (data pipeline lag)
# Fill with 0 for now, but this is a data quality issue to address

# %% [markdown]
# ## Temporal Patterns

# %%
# Check for distribution shift between train and test periods
# train_period = df[df["discharge_date"] < "2024-07-01"]
# test_period = df[df["discharge_date"] >= "2024-07-01"]
#
# for col in ["age", "los_days", "comorbidity_score"]:
#     from scipy.stats import ks_2samp
#     stat, p = ks_2samp(train_period[col].dropna(), test_period[col].dropna())
#     print(f"{col}: KS stat={stat:.4f}, p={p:.4f}")
#
# Results (from previous run):
# age: KS stat=0.0123, p=0.456  -- no significant shift
# los_days: KS stat=0.0089, p=0.712  -- no significant shift
# comorbidity_score: KS stat=0.0156, p=0.289  -- no significant shift
# Good news - no major distribution drift between periods

# %% [markdown]
# ## Key Takeaways
#
# 1. **Readmission rate is ~22%**, higher than national average (we're an AMC)
# 2. **Strongest predictor**: prior admissions in 6 months (frequent flyers)
# 3. **Age effect**: monotonic increase up to 85, slight drop after
# 4. **LOS effect**: U-shaped (very short and very long stays are risky)
# 5. **Insurance**: Medicaid highest rate, likely SDoH proxy
# 6. **Weekend discharge**: small but consistent effect
# 7. **No major distribution shift** between train/test periods
# 8. **Missing data** is manageable, mostly prior utilization for new patients
#
# Recommended features for v1 model:
# - age, los_days, los_log, prior_admissions_6mo, comorbidity_score
# - is_high_risk_drg, is_emergency_admit, discharged_weekend
# - insurance_type (one-hot), discharge_disposition (one-hot)
# - is_male
#
# Future work:
# - Lab values (hemoglobin, creatinine, sodium)
# - Medication data (polypharmacy, high-risk meds)
# - Social determinants (zip-code based deprivation index)
# - NLP on discharge summaries

# %%
print("Done!")
