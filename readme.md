# Adobe Launch Export Tool

![Adobe Launch Export Tool](https://img.shields.io/badge/Adobe_Experience_Platform-Data_Collection_Tags-red
) ![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)

A cross-platform desktop application for exporting rules (including their components), data elements, and extensions from **Adobe Experience Platform Data Collection Tags** (forever and always truly known as "Adobe Launch").

Designed for Implementation and Analytics professionals who need to audit implementations, back up complex properties, track changes in Git, or would like to have an easier starting point for release notes

## 🚀 Features

* **Full Property Export:** Downloads all Rules, Data Elements, and Extensions for a property as renders in production including upstream changes.
* **Library Export:** Can also grab the latest *Production* library and export only the rules / data elements / extensions modified in that build.
* **Smart Rule Organization:** Automatically breaks down Rule Components into `events`, `conditions`, and `actions` folders for easier diffing and auditing.
* **Bulk Actions:** Select one or many properties across your organization and export them in a single batch job.
* **Light/Dark Mode:** Because some people like blinding themselves, so you can do that if you really want to.

## 📦 Installation

### Download Binaries
Check the [Releases](../../releases) page for the latest installer:
* **macOS:** `.dmg`
* **Windows:** `.exe`
* **Linux:** `.AppImage`

### Run from Source
If you prefer to run the code directly or contribute:

1.  **Clone the repo**
    ```bash
    git clone [https://github.com/YOUR_USERNAME/adobe-launch-export-tool.git](https://github.com/YOUR_USERNAME/adobe-launch-export-tool.git)
    cd adobe-launch-export-tool
    ```

2.  **Install Dependencies**
    ```bash
    npm install
    ```

3.  **Start the App**
    ```bash
    npm start
    ```

## 🛠 Usage

1.  **Credentials:**
    * Obtain an **Adobe I/O Integration** (Oauth Server-to-Server) from [Adobe Developer Console](https://console.adobe.io/).
    * Ensure the integration has access to **Experience Platform Launch API**.
    * Enter your `Client ID`, `Client Secret`, and `Org ID` into the tool.
    * *Note: Credentials are encrypted and stored locally on your machine.*

2.  **Select Export Type:**
    * **Full Export:** Creates a complete backup of the property.
    * **Latest Library:** Useful for "What changed in the last deployment?" audits. Checks the Production environment for the most recent build and grabs the associated library.

3.  **Output Structure:**
    Files are saved in JSON format:
    ```text
    /Export Folder
      /Property Name
        /Full Export
          /rules
            /Rule Name
              /events
              /conditions
              /actions
              settings.json
          /data_elements
          /extensions
    ```

## 🔒 Security Note
This application communicates directly with `reactor.adobe.io` via credentials stored on your machine only. Your credentials are:
* **Never** sent to any third-party server.
* **Only** used to obtain an access token from Adobe IMS.

## Future Updates / To-Do
* Allow for selection of specific builds / libraries to pull-down (or allow for export of all builds)
* Add better support for duplicate rule names / data elements (just because you shouldn't do it, doesn't mean that there likely aren't a lot of properties that do that TBH I haven't tested what happens when they are found)
* Allow for generating release notes based on diffing last production to current production
* Opportunities to generate diffs automatically when selecting two libraries (dependent on library selection option)
* TBD

## 🤝 Contributing
Built by [Andy Lunsford](https://www.andylunsford.com).

1.  Fork the project
2.  Create your feature branch (`git checkout -b feature/AmazingFeature`)
3.  Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4.  Push to the branch (`git push origin feature/AmazingFeature`)
5.  Open a Pull Request

---
*Disclaimer: This is an open-source tool and is not an official product of Adobe Inc.*
