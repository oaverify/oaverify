# Bowtie harness image for oaverify's JSON Schema engine.
#
# Build from the repository root, so the engine sources are in context:
#
#   docker build -f conformance/bowtie/Dockerfile -t localhost/oaverify-harness .
#
# The builder stage bundles harness.ts and the engine into one ESM file.
# Only core, schema and formats are copied: those three are the whole
# transitive source closure of the compile/validate path, and core itself
# imports nothing outside its own tree.

FROM node:22-alpine AS builder

# esbuild lives one directory above the sources so that `import "esbuild"`
# resolves by walking up, without an npm install over the workspace manifest
# (whose `workspace:*` deps npm cannot resolve).
WORKDIR /src
RUN npm init -y > /dev/null && npm install --no-fund --no-audit esbuild@0.28.1

WORKDIR /src/repo
COPY package.json workspace-aliases.ts ./
COPY packages/core/src ./packages/core/src
COPY packages/schema/src ./packages/schema/src
COPY packages/formats/src ./packages/formats/src
COPY conformance/bowtie/harness.ts conformance/bowtie/build.mjs ./conformance/bowtie/
RUN node conformance/bowtie/build.mjs

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /src/repo/conformance/bowtie/dist/harness.mjs ./harness.mjs
CMD ["node", "harness.mjs"]
