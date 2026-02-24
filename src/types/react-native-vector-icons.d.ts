declare module 'react-native-vector-icons/Ionicons' {
  import { Component } from 'react';
  import { TextStyle } from 'react-native';

  export interface IoniconsProps {
    name: string;
    size?: number;
    color?: string;
    style?: TextStyle;
  }

  export default class Ionicons extends Component<IoniconsProps> {}
}
