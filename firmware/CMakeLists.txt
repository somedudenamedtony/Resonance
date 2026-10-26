# Resonance bridge firmware — native ESP-IDF project for the ESP32-S3-DevKitC-1 N16R8.
#   idf.py set-target esp32s3 && idf.py build flash monitor
cmake_minimum_required(VERSION 3.16)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
# The app version (esp_app_desc, shown when a rolled-back firmware is reported) is the bridge
# version, which is also what GitHub releases are tagged with.
file(STRINGS ${CMAKE_CURRENT_LIST_DIR}/components/resonance_core/include/rc_bridge.h RC_VERSION_LINE
     REGEX "^#define RC_BRIDGE_VERSION ")
string(REGEX REPLACE ".*\"(.*)\".*" "\\1" PROJECT_VER "${RC_VERSION_LINE}")
project(resonance-bridge)

# Put the built web app (app/dist) on the LittleFS partition so the bridge can serve it.
# Build the app first: `npm run build` at the repo root.
option(RESONANCE_FLASH_APP "Build a LittleFS image of app/dist" ON)
set(RESONANCE_APP_DIST ${CMAKE_CURRENT_LIST_DIR}/../app/dist)
if(RESONANCE_FLASH_APP AND EXISTS ${RESONANCE_APP_DIST}/index.html)
    littlefs_create_partition_image(littlefs ${RESONANCE_APP_DIST} FLASH_IN_PROJECT)
elseif(RESONANCE_FLASH_APP)
    message(WARNING "app/dist/index.html not found: the flash image will not include the web app. "
                    "Run `npm run build` at the repo root, then rebuild.")
endif()
