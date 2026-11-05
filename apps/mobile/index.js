import "react-native-get-random-values";
// The polyfills on the phone apps only (src/native-polyfills.native.js).
import "./src/native-polyfills";
import { registerRootComponent } from "expo";
import App from "./App";

registerRootComponent(App);
