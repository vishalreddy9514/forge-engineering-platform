"""Retrieval-augmented generation (FR-8): chunk, embed, store, retrieve, answer with citations.

Written directly rather than with a framework (ADR-0007): each step is a small typed function,
and the permission filter is plain SQL.
"""
