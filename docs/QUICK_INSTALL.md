# ACE Plug-in Quick Installation Guide

A guide for installing the Sharephe plug-in in i2b2 webclient 1.8.x.

### Prerequisites

- i2b2 Webclient 1.8.3 Release.

## Installing the Sharephe Plug-in

The following instructions assume that the i2b2 webclient directory is ```/var/www/html/webclient```.

### 1. Add the Plugin to the i2b2 Webclient

- Click on the link to download [ace_plugin_v1.0.zip](https://pitt-dbmi.s3.us-east-1.amazonaws.com/ace/ace_plugin_v1.0.zip).

- Extract file ***ace_plugin_v1.0.zip*** to the following i2b2 webclient plugin directory:

    ```
    /var/www/html/webclient/plugins/edu/pitt/dbmi
    ```

    Note that the path **edu/pitt/dbmi** may not exist in the directory path **/var/www/html/webclient/plugins**.  You can create it by execute the command ```mkdir -p edu/pitt/dbmi``` in the directory **/var/www/html/webclient/plugins**.

- Add the following content to the file ***plugins.json*** located in the directory ```/var/www/html/webclient/plugins```:

    ```
    "edu.pitt.dbmi.ace"
    ```

### 1. Configure the Plugin

- Change the default Web API URL to the URL where ACE application (Next.js) is running by modifying the value for the variable **window.ACE_REST_URL** in the file ***rest.js*** located in the directory ```/var/www/html/webclient/plugins/edu/pitt/dbmi/ace/js```

    For an example, assume that the URL to your ACE application is *https://my-host/ace*.  Change the variable from:

    ```
    window.ACE_REST_URL = 'http://localhost:3000';
    ```
    to:

    ```
    window.ACE_REST_URL = 'https://my-host/ace';
    ```