"""P2G41 arm B: gnomon v0.4.1 (GnomonV041's pinned install) running H1's hosted-recipe run() unchanged
(replay_reasoning, max_context_tokens 1,000,000, nudge_after_idle 100000 -- gnomon_harbor_h1.HOSTED_PATCH)."""
from gnomon_harbor_h1 import GnomonV040Hosted
from gnomon_harbor_v041 import GnomonV041


class GnomonV041Hosted(GnomonV041):
    run = GnomonV040Hosted.run  # H1's script byte for byte; install() is GnomonV041's

    @staticmethod
    def name() -> str:
        return "gnomon"
