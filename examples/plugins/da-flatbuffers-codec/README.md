# DA FlatBuffers Codec

This example treats DA FlatBuffers as an infrastructure plugin on the deploy
path.

It exposes manifest-defined methods for:

- field extraction
- typed record repacking

That keeps schema transforms inside the same flow runtime contract instead of
turning them into host-only helper code.
