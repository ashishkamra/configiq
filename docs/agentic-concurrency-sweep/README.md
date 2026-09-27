# Agentic/coding concurrency sweep

The corrected 1–16 concurrency review is in [configiq-local/README.md](configiq-local/README.md).

An earlier direct call to the public AISimulators gateway used a different service
from this repo's local ConfigIQ `/api/recommend` and sent an extra GPU-window
parameter. Its six-GPU result contradicted the app's one-GPU response and has
been discarded. Do not use the earlier data.
