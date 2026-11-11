#!/usr/bin/bash
# Replacement for upstream embuild.sh (cryptpad/onlyoffice-x2t-wasm). Same interface, knobs come from the environment:
#   X2T_OPT    optimisation flags for compile and link   (default -O2)
#   X2T_JOBS   make parallelism                           (default 12)
#   X2T_STACK  main thread stack size                     (default 4MB; upstream used 128kb)
#   X2T_FINAL_LFLAGS  extra link flags, only for the final X2tConverter link
# Threads are switched on for the whole build with EMCC_CFLAGS=-pthread (set in the Dockerfile), not here.

set -exo pipefail

POSITIONAL_ARGS=()

OPT="${X2T_OPT:--O2}"
QMAKE_ARGS="INCLUDEPATH+=/boost/libs/functional/include/"
J_ARG="-j ${X2T_JOBS:-12}"
QMAKE_LFLAGS="-sUSE_ICU=1 -sALLOW_MEMORY_GROWTH -sSTACK_SIZE=${X2T_STACK:-4MB} -sASSERTIONS=0 -sUSE_CLOSURE_COMPILER=1 -sERROR_ON_UNDEFINED_SYMBOLS=0 -sEMULATE_FUNCTION_POINTER_CASTS=1"
CFLAGS="-sUSE_ICU=1 -sUSE_BOOST_HEADERS=0 $OPT"
SANITIZE=""

if [ -n "$DEV_MODE" ]; then
  SANITIZE+=" -fsanitize=address -fsanitize=undefined -Wcast-align -Wover-aligned -sWARN_UNALIGNED=1"
  QMAKE_LFLAGS+=" -sINITIAL_MEMORY=400MB"
fi

while [[ $# -gt 0 ]]; do
  case $1 in
    -q)
      QMAKE_ARGS+=" $2"
      shift
      shift
      ;;
    -c)
      CFLAGS+=" $2"
      shift
      shift
      ;;
    -l)
      QMAKE_LFLAGS+=" $2"
      shift
      shift
      ;;
    -s)
      J_ARG=""
      shift
      ;;
    --no-sanitize)
      SANITIZE=""
      shift
      ;;
    *)
      POSITIONAL_ARGS+=("$1")
      shift
      ;;
  esac
done

if [[ "${POSITIONAL_ARGS[*]}" == *X2tConverter* ]]; then
  QMAKE_LFLAGS+=" $X2T_FINAL_LFLAGS"
fi

pushd /emsdk
. emsdk_env.sh
popd

qmake \
    "QMAKE_CXXFLAGS_RELEASE -= -O2" \
    "QMAKE_CXXFLAGS_RELEASE *= $OPT" \
    "QMAKE_CFLAGS_RELEASE -= -O2" \
    "QMAKE_CFLAGS_RELEASE *= $OPT" \
    "QMAKE_CC=emcc" \
    "QMAKE_CFLAGS+=$SANITIZE $CFLAGS" \
    "QMAKE_CXX=em++" \
    "QMAKE_CXXFLAGS+=$SANITIZE $CFLAGS" \
    "QMAKE_LINK=em++" \
    "QMAKE_LFLAGS+=$QMAKE_LFLAGS $SANITIZE $CFLAGS" \
    "DEFINES+=__linux__ HAVE_UNISTD_H _RWSTD_NO_SETRLIMIT" \
    "CONFIG += staticlib" \
    $QMAKE_ARGS \
    $POSITIONAL_ARGS

emmake make $J_ARG
