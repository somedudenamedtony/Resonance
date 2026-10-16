# Host build: C unit tests for the bridge core and `resonance-bridge-host`, the bridge core
# running on Linux/macOS for the emulator stack (see emulator/).
#
#   cmake -S firmware/host -B firmware/build-host -G Ninja && cmake --build firmware/build-host
#   ctest --test-dir firmware/build-host --output-on-failure
cmake_minimum_required(VERSION 3.16)
project(resonance_host C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Debug)
endif()
add_compile_options(-Wall -Wextra -Wno-unused-parameter)
if(CMAKE_BUILD_TYPE STREQUAL "Debug")
    add_compile_options(-fsanitize=address,undefined -fno-omit-frame-pointer)
    add_link_options(-fsanitize=address,undefined)
endif()

add_subdirectory(../components/resonance_core resonance_core)

add_executable(resonance-bridge-host bridge_host.c)
target_link_libraries(resonance-bridge-host PRIVATE resonance_core)

enable_testing()
add_executable(core_tests test/core_tests.c test/fake_nanovna.c)
target_link_libraries(core_tests PRIVATE resonance_core)
add_test(NAME core_tests COMMAND core_tests)
