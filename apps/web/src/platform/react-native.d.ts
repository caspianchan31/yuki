// v1.2: packages/client/src/platform-env.ts is the native file the Vite overlay replaces with
// src/platform/platform-env.ts, so the web build never loads React Native. The type checker
// still reads the native file, and this keeps that one import from failing it.
declare module "react-native";
