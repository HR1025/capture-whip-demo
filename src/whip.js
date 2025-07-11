/* global navigator */
/* global window */
/* global RTCPeerConnection */

export class WHIPClient {
  constructor() {
    //Ice properties
    this.iceUsername = null;
    this.icePassword = null;
    //Pending candidadtes
    this.candidates = [];
    this.endOfcandidates = false;

    this.onOffer = (offer) => offer;
    this.onAnswer = (answer) => answer;
  }

  async publish(pc, url, token) {
    //If already publishing
    if (this.pc) throw new Error("Already publishing");

    //Store pc object and token
    this.token = token;
    this.pc = pc;

    //Listen for state change events
    pc.onconnectionstatechange = (event) => {
      switch (pc.connectionState) {
        case "connected":
          // The connection has become fully connected
          break;
        case "disconnected":
        case "failed":
          // One or more transports has terminated unexpectedly or in an error
          break;
        case "closed":
          // The connection has been closed
          break;
      }
    };

    //Listen for candidates
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        //Ignore candidates not from the first m line
        if (event.candidate.sdpMLineIndex > 0)
          //Skip
          return;
        //Store candidate
        this.candidates.push(event.candidate);
      } else {
        //No more candidates
        this.endOfcandidates = true;
      }
      //Schedule patch on next tick if there is no already a timer or doing restart
      if (!this.iceTrickeTimeout && !this.restartIce)
        this.iceTrickeTimeout = setTimeout(() => this.patch(), 0);
    };
    //Create SDP offer
    const offer = await pc.createOffer();
    offer.sdp = this.onOffer(offer.sdp);

    //Request headers
    const headers = {
      "Content-Type": "application/sdp",
    };

    //If token is set
    if (token) headers["Authorization"] = "Bearer " + token;

    //Do the post request to the WHIP endpoint with the SDP offer
    const fetched = await fetch(url, {
      method: "POST",
      body: offer.sdp,
      headers,
    });

    if (!fetched.ok)
      throw new Error("Request rejected with status " + fetched.status);
    if (!fetched.headers.get("location"))
      throw new Error("Response missing location header");

    //Get the resource url
    this.resourceURL = new URL(fetched.headers.get("location"), url);

    //Get the links
    const links = {};

    //If the response contained any
    if (fetched.headers.has("link")) {
      //Get all links headers
      const linkHeaders = fetched.headers.get("link").split(/,\s+(?=<)/);

      //For each one
      for (const header of linkHeaders) {
        try {
          let rel,
            params = {};
          //Split in parts
          const items = header.split(";");
          //Create url server
          const url = items[0]
            .trim()
            .replace(/<(.*)>/, "$1")
            .trim();
          //For each other item
          for (let i = 1; i < items.length; ++i) {
            //Split into key/val
            const subitems = items[i].split(/=(.*)/);
            //Get key
            const key = subitems[0].trim();
            //Unquote value
            const value = subitems[1]
              ? subitems[1].trim().replaceAll('"', "").replaceAll("'", "")
              : subitems[1];
            //Check if it is the rel attribute
            if (key === "rel")
              //Get rel value
              rel = value;
            //Unquote value and set them
            else params[key] = value;
          }
          //Ensure it is an ice server
          if (!rel) continue;
          if (!links[rel]) links[rel] = [];
          //Add to config
          links[rel].push({ url, params });
        } catch (e) {
          console.error(e);
        }
      }
    }

    //Get current config
    const config = pc.getConfiguration();

    //If it has ice server info and it is not overriden by the client
    if (
      (!config.iceServer || !config.iceServer.length) &&
      links.hasOwnProperty("ice-server")
    ) {
      //ICe server config
      config.iceServers = [];

      //For each one
      for (const server of links["ice-server"]) {
        try {
          //Create ice server
          const iceServer = {
            urls: server.url,
          };
          //For each other param
          for (const [key, value] of Object.entries(server.params)) {
            //Get key in camel case
            const camelCase = key.replace(/([-_][a-z])/gi, ($1) =>
              $1.toUpperCase().replace("-", "").replace("_", "")
            );
            //Unquote value and set them
            iceServer[camelCase] = value;
          }
          //Add to config
          config.iceServers.push(iceServer);
        } catch (e) {
          //Ignore errors
        }
      }

      //If any configured
      if (config.iceServers.length)
        //Set it
        pc.setConfiguration(config);
    }

    //Get the SDP answer
    const answer = await fetched.text();

    //Get etag
    this.etag = fetched.headers.get("etag");

    //Schedule patch on next tick
    if (!this.iceTrickeTimeout)
      this.iceTrickeTimeout = setTimeout(() => this.patch(), 0);

    //Set local description
    await pc.setLocalDescription(offer);

    // TODO: chrome is returning a wrong value, so don't use it for now
    //try {
    //	//Get local ice properties
    //	const local = this.pc.getTransceivers()[0].sender.transport.iceTransport.getLocalParameters();
    //	//Get them for transport
    //	this.iceUsername = local.usernameFragment;
    //	this.icePassword = local.password;
    //} catch (e) {
    //Fallback for browsers not supporting ice transport
    this.iceUsername = offer.sdp.match(/a=ice-ufrag:(.*)\r\n/)[1];
    this.icePassword = offer.sdp.match(/a=ice-pwd:(.*)\r\n/)[1];
    //}

    //And set remote description
    await pc.setRemoteDescription({
      type: "answer",
      sdp: this.onAnswer(answer),
    });
  }

  async restart() {
    //Clear any pendint timeout
    this.iceTrickeTimeout = clearTimeout(this.iceTrickeTimeout);

    //Clean candidates and end of candidates flag as new ones will be retrieved
    this.candidates = [];
    this.endOfcandidates = false;

    //Restart ice
    this.pc.restartIce();
    //Create a new offer
    const offer = await this.pc.createOffer({ iceRestart: true });
    //Update ice
    this.iceUsername = offer.sdp.match(/a=ice-ufrag:(.*)\r\n/)[1];
    this.icePassword = offer.sdp.match(/a=ice-pwd:(.*)\r\n/)[1];
    //Set it
    await this.pc.setLocalDescription(offer);

    //Set restart flag time
    this.restartIce = new Date();

    //Clear any pendint timeout
    this.iceTrickeTimeout = clearTimeout(this.iceTrickeTimeout);

    //patch
    return this.patch();
  }

  async patch() {
    //Clear any pendint timeout
    this.iceTrickeTimeout = clearTimeout(this.iceTrickeTimeout);

    //Check if there is any pending data
    if (
      !(this.candidates.length || this.endOfcandidates || this.restartIce) ||
      !this.resourceURL
    )
      //Do nothing
      return;

    //Get data
    const candidates = this.candidates;
    const endOfcandidates = this.endOfcandidates;
    const restartIce = this.restartIce;

    //Clean pending data before async operation
    this.candidates = [];
    this.endOfcandidates = false;

    //Prepare fragment
    let fragment =
      "a=ice-ufrag:" +
      this.iceUsername +
      "\r\n" +
      "a=ice-pwd:" +
      this.icePassword +
      "\r\n";
    //Get peerconnection transceivers
    const transceivers = this.pc.getTransceivers();
    //Get medias
    const medias = {};
    //If doing something else than a restart
    if (candidates.length || endOfcandidates)
      //Create media object for first media always
      medias[transceivers[0].mid] = {
        mid: transceivers[0].mid,
        kind: transceivers[0].receiver.track.kind,
        candidates: [],
      };
    //For each candidate
    for (const candidate of candidates) {
      //Get mid for candidate
      const mid = candidate.sdpMid;
      //Get associated transceiver
      const transceiver = transceivers.find((t) => t.mid === mid);
      //Get media
      let media = medias[mid];
      //If not found yet
      if (!media)
        //Create media object
        media = medias[mid] = {
          mid,
          kind: transceiver.receiver.track.kind,
          candidates: [],
        };
      //Add candidate
      media.candidates.push(candidate);
    }
    //For each media
    for (const media of Object.values(medias)) {
      //Add media to fragment
      fragment +=
        "m=" +
        media.kind +
        " 9 UDP/TLS/RTP/SAVPF 0\r\n" +
        "a=mid:" +
        media.mid +
        "\r\n";
      //Add candidate
      for (const candidate of media.candidates)
        fragment += "a=" + candidate.candidate + "\r\n";
      if (endOfcandidates) fragment += "a=end-of-candidates\r\n";
    }

    //Request headers
    const headers = {
      "Content-Type": "application/trickle-ice-sdpfrag",
    };

    //If doing an ice restart
    if (restartIce)
      //Set if match to any
      headers["If-Match"] = "*";
    else if (this.etag)
      //Set if match to last known etag
      headers["If-Match"] = this.etag;

    //If token is set
    if (this.token) headers["Authorization"] = "Bearer " + this.token;

    //Do the post request to the WHIP resource
    const fetched = await fetch(this.resourceURL, {
      method: "PATCH",
      body: fragment,
      headers,
    });
    if (!fetched.ok && fetched.status !== 501 && fetched.status !== 405)
      throw new Error("Request rejected with status " + fetched.status);

    //If we have got an answer for the ice restart
    if (restartIce && fetched.status === 200) {
      //Get etag
      this.etag = fetched.headers.get("etag");

      //Get the SDP answer
      const answer = await fetched.text();
      //Get remote icename and password
      const iceUsername = answer.match(/a=ice-ufrag:(.*)\r\n/)[1];
      const icePassword = answer.match(/a=ice-pwd:(.*)\r\n/)[1];
      const candidates = Array.from(
        answer.matchAll(/(a=candidate:.*\r\n)/gm)
      ).map((res) => res[1]);

      //Get current remote rescription
      const remoteDescription = this.pc.remoteDescription;

      //Change username and password
      remoteDescription.sdp = remoteDescription.sdp.replaceAll(
        /(a=ice-ufrag:)(.*)\r\n/gm,
        "$1" + iceUsername + "\r\n"
      );
      remoteDescription.sdp = remoteDescription.sdp.replaceAll(
        /(a=ice-pwd:)(.*)\r\n/gm,
        "$1" + icePassword + "\r\n"
      );

      //Remove all candidates
      remoteDescription.sdp = remoteDescription.sdp.replaceAll(
        /(a=candidate:.*\r\n)/gm,
        ""
      );

      //Add candidates
      remoteDescription.sdp = remoteDescription.sdp.replaceAll(
        /(m=.*\r\n)/gm,
        "$1" + candidates.join()
      );

      //Set it
      await this.pc.setRemoteDescription(remoteDescription);

      //If we are still the last ice restart
      if (this.restartIce === restartIce) {
        //Clean the flag
        this.restartIce = null;
        //Check if there is any pending data
        if (this.candidates.length || this.endOfcandidates)
          //Tricke again
          this.patch();
      }
    }
  }

  async mute(muted) {
    //Request headers
    const headers = {
      "Content-Type": "application/json",
    };

    //If token is set
    if (this.token) headers["Authorization"] = "Bearer " + this.token;

    //Do the post request to the WHIP resource
    const fetched = await fetch(this.resourceURL, {
      method: "POST",
      body: JSON.stringify(muted),
      headers,
    });
  }

  async stop() {
    if (!this.pc) {
      // Already stopped
      return;
    }

    //Cancel any pending timeout
    this.iceTrickeTimeout = clearTimeout(this.iceTrickeTimeout);

    //Close peerconnection
    this.pc.close();

    //Null
    this.pc = null;

    //If we don't have the resource url
    if (!this.resourceURL)
      throw new Error("WHIP resource url not available yet");

    //Request headers
    const headers = {};

    //If token is set
    if (this.token) headers["Authorization"] = "Bearer " + this.token;

    //Send a delete
    await fetch(this.resourceURL, {
      method: "DELETE",
      headers,
    });
  }
}
