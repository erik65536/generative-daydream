"""Run SkinTokens' demo.py with its skeleton grammar fixed. Started by skintokens.py with SkinTokens' own Python:

    python skintokens_run.py <skintokens-dir> <demo.py arguments...>

SkinTokens writes a branch as the branch token, the parent joint and the new joint (six coordinates), and its
detokenizer reads it that way, but the grammar that constrains sampling (TokenizerPart.next_posible_token) lets the
skeleton go on after the first three. A branch closed there (an end, another branch or a part) breaks the decode:
"all input arrays must have the same shape" at the end, or joints read from token ids elsewhere. Sampling is not
seeded, so it strikes at random, more often on bodies with many limbs (a crab). Here the grammar asks for the new
joint's three coordinates before anything else, and for at least one joint before the end. The checkout itself stays
as installed.
"""
import os, runpy, sys


def branch_open(ids, branch: int, num_discrete: int) -> bool:
    """True while the last branch has its parent joint (three coordinates) but not yet all of the new one."""
    n = 0
    for t in reversed(ids):
        if t == branch:
            return n < 6
        if t >= num_discrete or n >= 6:
            return False
        n += 1
    return False


def patch_grammar():
    from src.tokenizer.tokenizer_part import TokenizerPart
    allowed = TokenizerPart.next_posible_token

    def next_posible_token(self, ids):
        seq = ids.tolist()
        if not isinstance(seq, list):
            return allowed(self, ids)
        if branch_open(seq, self.token_id_branch, self.num_discrete):
            return list(range(self.num_discrete))
        tokens = allowed(self, ids)
        # Nor may the skeleton end before its first joint.
        if not any(t < self.num_discrete for t in seq):
            tokens = [t for t in tokens if t != self.token_id_eos]
        return tokens

    TokenizerPart.next_posible_token = next_posible_token


if __name__ == '__main__':
    st_dir = os.path.abspath(sys.argv[1])
    os.chdir(st_dir)
    sys.path.insert(0, st_dir)
    patch_grammar()
    sys.argv = [os.path.join(st_dir, 'demo.py'), *sys.argv[2:]]
    runpy.run_path(sys.argv[0], run_name='__main__')
