# GhostAgent — Continuous Learning Architecture

## The Problem

Static detection patterns go stale. New AI frameworks ship weekly. Engineers
disguise AI systems in ways you haven't seen before. A scanner that doesn't
learn is a scanner that falls behind.

## Architecture: Three Feedback Loops

```
┌─────────────────────────────────────────────────────────┐
│                    SCAN EXECUTION                        │
│                                                         │
│  Codebase ──> Scanner ──> Raw Findings ──> Report       │
│                                     │                   │
│                                     ▼                   │
│                              ┌─────────────┐            │
│                              │  FEEDBACK    │            │
│                              │  COLLECTOR   │            │
│                              └──────┬──────┘            │
│                                     │                   │
│              ┌──────────────────────┼───────────────┐   │
│              ▼                      ▼               ▼   │
│     ┌────────────────┐  ┌──────────────────┐  ┌───────────────┐
│     │ LOOP 1:        │  │ LOOP 2:          │  │ LOOP 3:       │
│     │ Human Review   │  │ Cross-Repo       │  │ Pattern       │
│     │ Feedback       │  │ Aggregation      │  │ Evolution     │
│     └────────┬───────┘  └────────┬─────────┘  └───────┬───────┘
│              │                   │                     │
│              └───────────────────┼─────────────────────┘
│                                  ▼
│                        ┌─────────────────┐
│                        │  PATTERN STORE  │
│                        │  (versioned)    │
│                        └────────┬────────┘
│                                 │
│                                 ▼
│                      Next scan uses updated
│                      patterns + risk weights
└─────────────────────────────────────────────────────────┘
```

---

## Loop 1: Human Review Feedback

**What:** After every scan, the reviewer marks findings as:
- `confirmed` — real finding, correctly classified
- `false_positive` — not actually an AI asset or risk
- `missed` — reviewer manually adds something the scanner didn't catch
- `severity_wrong` — finding is real but severity should be different

**Storage schema:**

```json
{
  "scan_id": "scan_2026-04-09_meridian",
  "repo": "meridian-health-synthetic",
  "feedback": [
    {
      "finding_id": "f-001",
      "file": ".env.example:150",
      "verdict": "confirmed",
      "adjusted_severity": null,
      "notes": null
    },
    {
      "finding_id": null,
      "file": "ml/nlu-triage/notebooks/error_analysis.py:283",
      "verdict": "missed",
      "adjusted_severity": "CRITICAL",
      "category": "patient_safety_ai",
      "notes": "Model documents missed suicide classifications. Scanner didn't flag error analysis files.",
      "suggested_pattern": "self-harm|suicide|missed emergenc|safety net|MUST-FIX"
    },
    {
      "finding_id": "f-003",
      "file": "services/billing/src/routes/payments.ts",
      "verdict": "false_positive",
      "notes": "Stripe integration is standard payment processing, not AI"
    }
  ]
}
```

**How it feeds back:**
1. `missed` findings generate candidate detection patterns
2. `false_positive` findings add exclusion rules
3. `severity_wrong` findings adjust risk scoring weights
4. After 5+ confirmed instances of a new pattern across repos, auto-promote it to the default ruleset

---

## Loop 2: Cross-Repo Pattern Aggregation

**What:** After scanning N repos, aggregate findings to discover:
- Which detection categories have the highest miss rate
- Which industries (healthcare, fintech, etc.) have unique patterns
- Which AI frameworks/tools are trending in enterprise codebases

**Implementation:**

```typescript
interface ScanResult {
  repo: string;
  industry: string;       // healthcare, fintech, saas, etc.
  scan_date: string;
  findings: Finding[];
  feedback: Feedback[];   // from Loop 1
}

// After each scan batch, run aggregation:
function aggregatePatterns(scans: ScanResult[]): PatternUpdate {
  // 1. Find patterns that were "missed" across multiple repos
  const missedPatterns = scans
    .flatMap(s => s.feedback.filter(f => f.verdict === 'missed'))
    .reduce(groupBySuggestedPattern);

  // 2. Patterns missed in 3+ repos become candidates for promotion
  const promotionCandidates = missedPatterns
    .filter(p => p.occurrences >= 3);

  // 3. Find false positives that recur — these need exclusion rules
  const falsePositivePatterns = scans
    .flatMap(s => s.feedback.filter(f => f.verdict === 'false_positive'))
    .reduce(groupByPattern);

  // 4. Industry-specific patterns
  const industryPatterns = scans
    .filter(s => s.industry === 'healthcare')
    .flatMap(s => s.feedback.filter(f => f.verdict === 'missed'))
    .reduce(groupByCategory);

  return {
    new_patterns: promotionCandidates,
    new_exclusions: falsePositivePatterns.filter(p => p.occurrences >= 3),
    industry_rules: industryPatterns,
    risk_weight_adjustments: computeWeightAdjustments(scans)
  };
}
```

**Cadence:** Run aggregation weekly. Review promoted patterns monthly.

---

## Loop 3: Pattern Evolution (Automated)

**What:** Automatically discover new AI-related patterns by monitoring:

### 3a. Dependency Watching
Track new packages/libraries that appear in scanned repos:

```typescript
// Known AI-adjacent package prefixes to watch for
const AI_PACKAGE_SIGNALS = [
  /^@langchain/,   /^langchain/,
  /^@llama-?index/, /^llamaindex/,
  /^@huggingface/, /^transformers/,
  /^openai/,       /^anthropic/,
  /^@anthropic/,   /^cohere/,
  /^replicate/,    /^together-?ai/,
  /^@google-ai/,   /^@google\/generative/,
  /^ollama/,       /^vllm/,
  /^chromadb/,     /^pinecone/,
  /^weaviate/,     /^qdrant/,
  /^instructor/,   /^outlines/,
  /^dspy/,         /^guidance/,
  /^autogen/,      /^crewai/,
  /^@ai-sdk/,      /^ai$/,
];

// On every scan, check for NEW packages not in the known list
function detectNewAIPackages(packageJson: any): string[] {
  const allDeps = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies
  };
  return Object.keys(allDeps).filter(dep =>
    !AI_PACKAGE_SIGNALS.some(p => p.test(dep)) &&
    looksAIRelated(dep, allDeps[dep])
  );
}

// Heuristic: package name contains these terms
function looksAIRelated(name: string, version: string): boolean {
  const signals = [
    'llm', 'gpt', 'bert', 'embed', 'vector', 'rag',
    'agent', 'chat', 'completion', 'inference', 'predict',
    'classify', 'sentiment', 'ner', 'nlp', 'ocr', 'vision',
    'diffusion', 'stable', 'whisper', 'speech', 'tts'
  ];
  return signals.some(s => name.toLowerCase().includes(s));
}
```

### 3b. Env Var Pattern Mining
Every time a `missed` finding comes from an env/config file, extract the variable name pattern:

```typescript
// Build a growing list of env var patterns that indicate AI systems
const learnedEnvPatterns: RegExp[] = [
  // Seeded from known patterns:
  /ML_|AI_|MODEL_|SCORING_|INFERENCE_|PREDICTION_/i,
  /OPENAI|ANTHROPIC|COHERE|HUGGINGFACE/i,
  /CONFIDENCE_THRESHOLD|ANOMALY_THRESHOLD/i,

  // Learned from missed findings:
  // (these get added automatically when reviewers mark env vars as missed)
];

function learnEnvPattern(missedFinding: Feedback): void {
  if (missedFinding.file.includes('.env') || missedFinding.file.includes('config')) {
    const varName = extractVarName(missedFinding.evidence);
    if (varName) {
      // Add to candidate patterns, promote after 3 occurrences
      candidateEnvPatterns.push({
        pattern: varName,
        firstSeen: new Date(),
        occurrences: 1,
        repos: [missedFinding.repo]
      });
    }
  }
}
```

### 3c. File Path Pattern Mining
Learn which directories and filenames tend to contain AI assets:

```typescript
// After enough scans, the system learns:
// - ml/ directories always have findings
// - experiments/ has high-risk prototypes
// - cron/weekly/ often has autonomous AI jobs
// - notebooks/ contain model evaluation with safety info
// - **/error_analysis* files reveal known model failures

function computePathRiskScore(filePath: string): number {
  let score = 0;
  const segments = filePath.split('/');

  // Learned from confirmed findings across repos
  const riskyPaths: Record<string, number> = {
    'ml': 30,
    'models': 25,
    'experiments': 20,
    'prototype': 20,
    'notebooks': 15,
    'cron': 15,
    'workers': 10,
    'scripts': 5,
  };

  for (const segment of segments) {
    for (const [pattern, weight] of Object.entries(riskyPaths)) {
      if (segment.toLowerCase().includes(pattern)) {
        score += weight;
      }
    }
  }

  return score;
}
```

---

## Implementation: Feedback Database

Store all scan results and feedback in a simple append-only store:

```sql
CREATE TABLE scan_runs (
  id          UUID PRIMARY KEY,
  repo        TEXT NOT NULL,
  branch      TEXT,
  industry    TEXT,
  scanned_at  TIMESTAMPTZ NOT NULL,
  file_count  INT,
  finding_count INT,
  scanner_version TEXT
);

CREATE TABLE findings (
  id          UUID PRIMARY KEY,
  scan_id     UUID REFERENCES scan_runs(id),
  file_path   TEXT NOT NULL,
  line_number INT,
  category    TEXT NOT NULL,
  severity    TEXT NOT NULL,
  risk_score  INT NOT NULL,
  title       TEXT NOT NULL,
  description TEXT,
  evidence    TEXT,
  owner       TEXT,
  owner_confidence INT,
  phi_exposure BOOLEAN
);

CREATE TABLE feedback (
  id          UUID PRIMARY KEY,
  finding_id  UUID REFERENCES findings(id),  -- null if "missed"
  scan_id     UUID REFERENCES scan_runs(id),
  verdict     TEXT NOT NULL,  -- confirmed, false_positive, missed, severity_wrong
  adjusted_severity TEXT,
  category    TEXT,           -- for missed findings
  file_path   TEXT,           -- for missed findings
  evidence    TEXT,           -- for missed findings
  suggested_pattern TEXT,     -- regex the reviewer suggests
  notes       TEXT,
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE learned_patterns (
  id              UUID PRIMARY KEY,
  pattern         TEXT NOT NULL,
  pattern_type    TEXT NOT NULL,  -- regex, env_var, file_path, dependency
  category        TEXT NOT NULL,
  source          TEXT NOT NULL,  -- manual, loop1_promotion, loop2_aggregation, loop3_auto
  occurrences     INT DEFAULT 1,
  false_positives INT DEFAULT 0,
  precision       FLOAT,  -- confirmed / (confirmed + false_positive)
  promoted_at     TIMESTAMPTZ,
  is_active       BOOLEAN DEFAULT false,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- View: patterns ready for promotion (3+ occurrences, <20% false positive rate)
CREATE VIEW promotable_patterns AS
SELECT * FROM learned_patterns
WHERE is_active = false
  AND occurrences >= 3
  AND (false_positives::float / GREATEST(occurrences, 1)) < 0.2;
```

---

## The Flywheel

```
Scan 1:  Find 17/26 issues  (65% recall)
          ↓ human reviews, marks 9 missed
Scan 2:  Patterns updated → find 22/26 issues  (85% recall)
          ↓ new repo type, 3 novel patterns missed
Scan 3:  Cross-repo aggregation → find 24/26  (92% recall)
          ↓ false positives reduced
Scan 10: Find 25/26, 1 false positive  (96% recall, 96% precision)
```

Every scan makes the next scan better. Every human review teaches the system
something it didn't know. Every new repo in a new industry adds patterns
the system has never seen.

---

## Quick Start: Minimum Viable Learning Loop

If you want this running in a week, implement just these three things:

### 1. Add a `--feedback` flag to your CLI
```bash
ghostagent scan ./repo --output findings.json
ghostagent feedback findings.json --interactive
# walks through each finding, asks confirmed/false_positive/severity_wrong
# asks "did we miss anything?" at the end
```

### 2. Store feedback in a JSON file per repo
```
~/.ghostagent/feedback/
  meridian-health-synthetic_2026-04-09.json
  acme-fintech_2026-04-10.json
```

### 3. Before each scan, load learned patterns
```typescript
async function loadPatterns(): Promise<DetectionPattern[]> {
  const builtIn = await loadBuiltInPatterns();        // your default ruleset
  const learned = await loadLearnedPatterns();         // from feedback files
  const promoted = learned.filter(p => p.occurrences >= 3 && p.precision > 0.8);
  return [...builtIn, ...promoted];
}
```

That's it. Ship it, get feedback, iterate. The database and aggregation
can come later when you have 20+ repos scanned.
