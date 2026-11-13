import http from "k6/http";
import { check } from "k6";
import { bootstrap, getAuthHeaders, BASE_URL } from "./helpers/setup.js";

export var options = {
  stages: [
    { duration: '10s', target: 100 },
    { duration: '50s', target: 100 },
  ],
};

export function setup() {
  return bootstrap();
}

export default function (data) {
  var res = http.post(BASE_URL + "/api/ping", "{}", {
    headers: getAuthHeaders(data.apiKey),
    responseCallback: http.expectedStatuses(200, 429),
  });

  check(res, {
    "is status 200 or 429": function(r) { return r.status === 200 || r.status === 429; },
  });
}
