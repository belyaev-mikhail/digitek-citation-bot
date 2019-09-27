#!/usr/bin/env bash
set -e

function get_os_for_node() {
    local _os=`uname -s`
    case ${_os} in
        "Linux")
            _os_for_node="linux"
            ;;
        "Darwin")
            _os_for_node="darwin"
            ;;
        *)
            echo "I don't know how to download node for your platform =("
            exit 1
    esac
}

function get_platform_for_node() {
    local _platform=`uname -m`
    case ${_platform} in
        "x86_64")
            _platform_for_node="x64"
            ;;
        "x86")
            ;&
        "i386")
            ;&
        "i486")
            ;&
        "i586")
            ;&
        "i686")
            _platform_for_node="x86"
            ;;
        *)
            echo "I don't know how to download node for your platform =("
            exit 1
    esac
}

function get_node_filename() {
    get_os_for_node
    get_platform_for_node
    local _ext

    case ${_os_for_node} in
        "linux")
            _ext="tar.xz"
            ;;
        "darwin")
            _ext="tar.gz"
            ;;
        *)
            echo "This shouldn't have happened"
            exit 1
    esac

    _node_filename="node-${NODE_VERSION}-${_os_for_node}-${_platform_for_node}.${_ext}"
}

function get_node_download_url() {
    get_node_filename
    _node_download_url="${NODE_BASE_URL}/${NODE_VERSION}/${_node_filename}"
}

function install_node() {
    get_node_download_url
    mkdir -p ${NODE_BASE_PATH}
    wget -O "${NODE_BASE_PATH}/node.tar" ${_node_download_url}
    tar xvf "${NODE_BASE_PATH}/node.tar" -C ${NODE_BASE_PATH} --strip-components 1
    rm "${NODE_BASE_PATH}/node.tar"
}

function uninstall_node() {
    rm -rf "${NODE_BASE_PATH}"
}

function is_node_installed() {
    if [[ -x "${NODE_BASE_PATH}/bin/node" ]]; then
        _node_installed=true
    fi
}

function install_yarn() {
    local_npm install -g "yarn@${YARN_VERSION}"
}

function uninstall_yarn() {
    local_npm uninstall -g "yarn"
}

function is_yarn_installed() {
    if [[ -x "${NODE_BASE_PATH}/bin/yarn" ]]; then
        _yarn_installed=true
    fi
}

function local_node() {
    /usr/bin/env PATH="${NODE_BASE_PATH}/bin:${PATH}" node $@
}

function local_npm() {
    /usr/bin/env PATH="${NODE_BASE_PATH}/bin:${PATH}" npm $@
}

function local_yarn() {
    /usr/bin/env PATH="${NODE_BASE_PATH}/bin:${PATH}" yarn $@
}


function get_local_node_version() {
    _local_node_version=`local_node --version`
}

function get_local_yarn_version() {
    _local_yarn_version=`local_yarn --version`
}

function is_node_up_to_date() {
    get_local_node_version

    if [[ ${NODE_VERSION} == ${_local_node_version} ]]; then
        _node_up_to_date=true
    fi
}

function is_yarn_up_to_date() {
    get_local_yarn_version
    if [[ ${YARN_VERSION} == ${_local_yarn_version} ]]; then
        _yarn_up_to_date=true
    fi
}
