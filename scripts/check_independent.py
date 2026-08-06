#!/usr/bin/env python3
"""Re-derive the recorded game from its code alone, in Python, sharing no code with the page.

This file is deliberately a clean room. It imports nothing from src/, it never shells out to
node, and it does not transliterate the JavaScript: the board here is a dict keyed by (row,
column) rather than a flat typed array, and the mixed radix arithmetic uses Python's own
integers rather than BigInt. Two implementations of the same specification written the same
way share their bugs, which is the whole reason the fleet keeps getting bitten by validators
that agree with the thing they validate.

What it knows is the wire format, which is a specification and not an implementation:

  * The code is unpadded URL safe base64 of [version][game id][payload big endian][crc16].
  * CRC-16/CCITT-FALSE, initial value 0xFFFF, polynomial 0x1021, no reflection, no final xor.
  * The payload is one integer. Reading it: while the value is above 1, generate the legal
    moves at the current position in ascending cell order, take the value modulo their count
    as an index, divide, and play that move.
  * Before every read, and after the last one, advance through any position where the mover
    has no legal move (a pass) or exactly one (a forced move). Those carry no information.

Usage: check_independent.py fixtures/recorded-game.json
Exit 0 when every field in the fixture is re-derived exactly.
"""
import json
import sys

ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
BLACK, WHITE = "b", "w"
DIRECTIONS = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


class Rejected(Exception):
    pass


def b64url_decode(text):
    """Bytes from an unpadded URL safe base64 string, refusing anything else."""
    bits = 0
    width = 0
    out = bytearray()
    for i, character in enumerate(text):
        try:
            value = ALPHABET.index(character)
        except ValueError:
            raise Rejected(f"character {character!r} at {i} is not part of a code")
        bits = (bits << 6) | value
        width += 6
        if width >= 8:
            width -= 8
            out.append((bits >> width) & 0xFF)
            bits &= (1 << width) - 1
    if bits != 0:
        raise Rejected("the trailing bits of the code are not zero")
    if width >= 6:
        raise Rejected(f"a code cannot be {len(text)} characters long")
    return bytes(out)


def b64url_encode(data):
    bits = 0
    width = 0
    out = []
    for byte in data:
        bits = (bits << 8) | byte
        width += 8
        while width >= 6:
            width -= 6
            out.append(ALPHABET[(bits >> width) & 0x3F])
            bits &= (1 << width) - 1
    if width:
        out.append(ALPHABET[(bits << (6 - width)) & 0x3F])
    return "".join(out)


def crc16_ccitt_false(data):
    crc = 0xFFFF
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


# ---------------------------------------------------------------- the rules, from scratch

def opening():
    """Squares as (row, column), zero based, row 0 being rank 1."""
    return {(3, 3): WHITE, (3, 4): BLACK, (4, 3): BLACK, (4, 4): WHITE}


def other(colour):
    return WHITE if colour == BLACK else BLACK


def captures(board, square, colour):
    """Every disc placing at square would turn over. Empty means the move is not legal."""
    if square in board:
        return []
    row, column = square
    taken = []
    for drow, dcolumn in DIRECTIONS:
        run = []
        r, c = row + drow, column + dcolumn
        while 0 <= r < 8 and 0 <= c < 8 and board.get((r, c)) == other(colour):
            run.append((r, c))
            r, c = r + drow, c + dcolumn
        if run and 0 <= r < 8 and 0 <= c < 8 and board.get((r, c)) == colour:
            taken.extend(run)
    return taken


def legal_moves(board, colour):
    """Ascending flat cell index order, which the wire format depends on."""
    found = []
    for row in range(8):
        for column in range(8):
            if captures(board, (row, column), colour):
                found.append((row, column))
    return sorted(found, key=lambda sq: sq[0] * 8 + sq[1])


def place(board, square, colour):
    taken = captures(board, square, colour)
    if not taken:
        raise Rejected(f"{name_of(square)} captures nothing and is not a legal move")
    fresh = dict(board)
    fresh[square] = colour
    for sq in taken:
        fresh[sq] = colour
    return fresh


def finished(board, colour):
    return not legal_moves(board, colour) and not legal_moves(board, other(colour))


def name_of(square):
    return "abcdefgh"[square[1]] + str(square[0] + 1)


def flat(square):
    return square[0] * 8 + square[1]


def settle(board, colour, plies):
    """Play through every position that offers the mover no choice, recording each one."""
    for _ in range(200):
        if finished(board, colour):
            return board, colour
        moves = legal_moves(board, colour)
        if len(moves) == 0:
            plies.append({"kind": "pass", "by": colour})
            colour = other(colour)
        elif len(moves) == 1:
            plies.append({"kind": "forced", "by": colour, "square": moves[0]})
            board = place(board, moves[0], colour)
            colour = other(colour)
        else:
            return board, colour
    raise Rejected("the game did not settle within 200 plies")


def replay(code):
    """Everything the code determines, derived here and nowhere else."""
    raw = b64url_decode(code)
    if len(raw) < 5:
        raise Rejected(f"a code is at least 5 bytes and this one is {len(raw)}")
    body, checksum = raw[:-2], int.from_bytes(raw[-2:], "big")
    if crc16_ccitt_false(body) != checksum:
        raise Rejected("the checksum does not match, this code did not arrive intact")
    version, game_id = body[0], body[1]
    if version != 1:
        raise Rejected(f"format {version} is not one this checker reads")
    if game_id != 1:
        raise Rejected(f"game {game_id} is not Reversi")

    value = int.from_bytes(body[2:], "big")
    board, colour = opening(), BLACK
    plies = []
    digits = []
    board, colour = settle(board, colour, plies)
    while value > 1:
        if finished(board, colour):
            raise Rejected("the code carries moves that come after the game ended")
        moves = legal_moves(board, colour)
        if len(moves) < 2:
            raise Rejected("a digit was read at a position with no real choice")
        index = value % len(moves)
        value //= len(moves)
        digits.append((len(moves), index))
        plies.append({"kind": "move", "by": colour, "square": moves[index]})
        board = place(board, moves[index], colour)
        colour = other(colour)
        board, colour = settle(board, colour, plies)

    # The reader must land exactly on the sentinel the writer started from. Stopping merely
    # because the value fell below two also accepts values that reach zero, and those are
    # codes the writer cannot produce. Checked here as part of the specification rather than
    # copied from the JavaScript.
    if value != 1:
        raise Rejected(f"the payload ended at {value} rather than the sentinel 1, so this code was not written by this format")

    black = sum(1 for v in board.values() if v == BLACK)
    white = sum(1 for v in board.values() if v == WHITE)
    return {
        "board": board,
        "digits": digits,
        "plies": plies,
        "score": {"black": black, "white": white},
        "winner": "draw" if black == white else ("black" if black > white else "white"),
        "over": finished(board, colour),
    }


def to_code(digits):
    """The encoder, so the code can be checked for being the canonical one."""
    value = 1
    for radix, index in reversed(digits):
        if radix < 2 or not 0 <= index < radix:
            raise Rejected(f"digit ({radix}, {index}) is not writable")
        value = value * radix + index
    payload = value.to_bytes(max(1, (value.bit_length() + 7) // 8), "big")
    body = bytes([1, 1]) + payload
    return b64url_encode(body + crc16_ccitt_false(body).to_bytes(2, "big"))


def main(path):
    fixture = json.load(open(path, encoding="utf-8"))
    derived = replay(fixture["code"])
    problems = []

    def compare(label, got, want):
        if got != want:
            problems.append(f"{label}: this checker derived {got!r}, the fixture records {want!r}")

    picture = "".join(
        derived["board"].get((row, column), ".")
        for row in range(8)
        for column in range(8)
    )
    decisions = [flat(p["square"]) for p in derived["plies"] if p["kind"] == "move"]
    derived_plies = sum(1 for p in derived["plies"] if p["kind"] != "move")

    compare("final board", picture, fixture["finalBoard"])
    compare("score", derived["score"], fixture["score"])
    compare("winner", derived["winner"], fixture["winner"])
    compare("total plies", len(derived["plies"]), fixture["plies"])
    compare("recorded decisions", len(derived["digits"]), fixture["recordedDecisions"])
    compare("derived plies", derived_plies, fixture["derivedPlies"])
    compare("the decisions the browser clicked", decisions, fixture["decisions"])
    compare("code length", len(fixture["code"]), fixture["codeLength"])
    compare("re-encoding the game", to_code(derived["digits"]), fixture["code"])

    if not derived["over"]:
        problems.append("the game does not actually end")
    if derived["score"]["black"] + derived["score"]["white"] != 64:
        problems.append("the board is not full at the end and the fixture claims a finished game")
    sentence = (
        f"{derived['winner'].capitalize()} wins, "
        f"{max(derived['score'].values())} to {min(derived['score'].values())}."
    )
    compare("the sentence the page prints", sentence, fixture["outcome"])

    print(
        f"        replayed {len(fixture['code'])} characters into {len(derived['plies'])} plies: "
        f"{len(derived['digits'])} decisions read, {derived_plies} re-derived, "
        f"{derived['score']['black']}-{derived['score']['white']} to {derived['winner']}"
    )
    for problem in problems:
        print(f"        {problem}")
    return 1 if problems else 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    try:
        sys.exit(main(sys.argv[1]))
    except Rejected as err:
        print(f"        the code was rejected: {err}")
        sys.exit(1)
