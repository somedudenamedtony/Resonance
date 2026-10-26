# Resonance bridge core. Builds as an ESP-IDF component, or as a plain library for host tests.
set(RC_SRCS
    src/rc_shell.c
    src/rc_scan.c
    src/rc_bridge.c
    src/rc_update.c
    third_party/cjson/cJSON.c)

if(ESP_PLATFORM)
    idf_component_register(SRCS ${RC_SRCS}
                           INCLUDE_DIRS include third_party/cjson)
else()
    add_library(resonance_core STATIC ${RC_SRCS})
    target_include_directories(resonance_core PUBLIC include third_party/cjson)
    target_link_libraries(resonance_core PUBLIC m)
endif()
