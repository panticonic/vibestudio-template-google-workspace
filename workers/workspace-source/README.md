# Workspace source builtin

This host-shipped builtin owns semantic workspace authority. The generated
builtin catalog binds its exact source, class, protocol, and singleton object
coordinate; mutable workspace code cannot replace it.

Its stable logical service is `gad.workspace`, declared by the flattened
workspace manifest. The concrete source and class are workspace-owned and are
resolved through the `vibestudio.workspace-source.v1` protocol.
